"""
AI Imagination Studio — local server with image proxy.
Run:  python server.py
Open: http://localhost:8765
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, quote, urlparse
import json
import os
import ssl
import time
import urllib.error
import urllib.request

PORT = 8765
PLACEHOLDR_BASE = "https://placeholdr.dev"
POLLINATIONS_BASE = "https://image.pollinations.ai/prompt"
TIMEOUT_SEC = 120
POLL_INTERVAL_SEC = 3

STYLE_MAP = {
    "turbo": "photographic",
    "flux": "artistic",
    "fast": "photographic",
    "balanced": "artistic",
    "quality": "oil-painting",
}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_HEAD(self):
        if urlparse(self.path).path == "/api/image":
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.end_headers()
            return
        super().do_HEAD()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/image":
            self.proxy_image(parse_qs(parsed.query))
            return
        super().do_GET()

    @staticmethod
    def is_image(data: bytes) -> bool:
        if len(data) < 1000:
            return False
        if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
            return True
        if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
            return True
        return False

    def fetch_url(self, url: str, timeout: int = 60) -> tuple[bytes, str, int]:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "AI-Imagination-Studio/1.0"},
        )
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            data = resp.read()
            ctype = resp.headers.get("Content-Type", "image/jpeg")
            return data, ctype, resp.status

    def fetch_placeholdr(self, prompt: str, width: str, height: str, style: str, seed: str):
        w, h = max(128, min(2048, int(width))), max(128, min(2048, int(height)))
        ph_seed = str((int(seed) % 3) + 1)
        url = f"{PLACEHOLDR_BASE}/{w}x{h}/{quote(prompt)}?style={style}&seed={ph_seed}"

        print(f"[placeholdr] {w}x{h} style={style} — {prompt[:60]}...")
        deadline = time.time() + TIMEOUT_SEC

        while time.time() < deadline:
            try:
                data, ctype, status = self.fetch_url(url, timeout=60)
            except urllib.error.HTTPError as e:
                data = e.read()
                status = e.code
                ctype = e.headers.get("Content-Type", "")

            if self.is_image(data):
                print(f"[placeholdr] Done — {len(data)} bytes")
                return data, ctype.split(";")[0]

            if status == 202 or data[:5] == b"<?xml" or data[:4] == b"<svg":
                print("[placeholdr] Waiting for render...")
                time.sleep(POLL_INTERVAL_SEC)
                continue

            raise RuntimeError("placeholdr.dev returned unexpected data")

        raise TimeoutError("Image generation timed out. Try again.")

    def fetch_pollinations(self, prompt: str, width: str, height: str, model: str, seed: str):
        params = f"width={width}&height={height}&model={model}&seed={seed}"
        url = f"{POLLINATIONS_BASE}/{quote(prompt)}?{params}"
        print(f"[pollinations] Trying fallback...")

        try:
            data, ctype, _ = self.fetch_url(url, timeout=TIMEOUT_SEC)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:400]
            if e.code == 402:
                raise RuntimeError(
                    "Pollinations rate limit reached (402). Using placeholdr.dev instead — "
                    "or get a free key at https://enter.pollinations.ai"
                ) from e
            raise RuntimeError(f"Pollinations error ({e.code}): {body}") from e

        if not self.is_image(data):
            raise RuntimeError("Pollinations returned non-image data")
        print(f"[pollinations] Done — {len(data)} bytes")
        return data, ctype.split(";")[0]

    def proxy_image(self, query):
        prompt = (query.get("prompt") or [""])[0].strip()
        if not prompt:
            self.send_json_error(400, "Missing prompt")
            return

        width = (query.get("width") or ["384"])[0]
        height = (query.get("height") or ["384"])[0]
        model = (query.get("model") or ["turbo"])[0]
        style = (query.get("style") or [STYLE_MAP.get(model, "photographic")])[0]
        seed = (query.get("seed") or [str(time.time_ns())])[0]

        try:
            try:
                data, ctype = self.fetch_placeholdr(prompt, width, height, style, seed)
            except Exception as ph_err:
                print(f"[placeholdr] Failed: {ph_err}")
                data, ctype = self.fetch_pollinations(prompt, width, height, model, seed)

            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        except TimeoutError:
            print("[proxy] Timed out")
            self.send_json_error(504, "Generation timed out. Try a shorter prompt.")
        except Exception as e:
            print(f"[proxy] Error: {e}")
            self.send_json_error(502, str(e))

    def send_json_error(self, code, message):
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"AI Imagination Studio running at http://localhost:{PORT}")
    print("Image provider: placeholdr.dev (free)")
    print("Press Ctrl+C to stop.\n")
    HTTPServer(("", PORT), Handler).serve_forever()
