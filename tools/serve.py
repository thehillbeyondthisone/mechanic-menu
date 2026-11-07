"""Static server for the Patterson splat menu.

  http://127.0.0.1:8765/            desktop (this PC)
  https://<LAN-IP>:8766/            Quest 3 browser (WebXR needs HTTPS; accept the
                                    self-signed certificate warning once)

usage: python serve.py [--no-https]
"""
import http.server
import mimetypes
import shutil
import socket
import ssl
import subprocess
import sys
import threading
from urllib.parse import urlsplit
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "viewer"
CERT_DIR = Path(__file__).resolve().parent.parent / "cert"
HTTP_PORT, HTTPS_PORT = 8765, 8766

for ext, mime in {".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
                  ".json": "application/json", ".spz": "application/octet-stream",
                  ".bin": "application/octet-stream", ".ply": "application/octet-stream",
                  ".woff2": "font/woff2"}.items():
    mimetypes.add_type(mime, ext)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".wasm": "application/wasm", ".spz": "application/octet-stream"}

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            self.path = "/menu.html"
        elif path == "/mechanic":
            self.send_response(301)
            self.send_header("Location", "./mechanic/")
            self.end_headers()
            return
        elif path in ("/mechanic/", "/mechanic/index.html"):
            html = (ROOT / "index.html").read_text(encoding="utf-8")
            body = html.replace("<head>", '<head>\n<base href="../">', 1).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            sys.stderr.write("404 " + self.path + "\n")


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    CERT_DIR.mkdir(exist_ok=True)
    crt, key = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    if crt.exists() and key.exists() and (CERT_DIR / "ip.txt").exists() and (CERT_DIR / "ip.txt").read_text() == ip:
        return crt, key
    openssl = shutil.which("openssl") or r"C:\Program Files\Git\usr\bin\openssl.exe"
    subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
                    "-keyout", str(key), "-out", str(crt), "-subj", "/CN=patterson-menu",
                    "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost"],
                   check=True, capture_output=True)
    (CERT_DIR / "ip.txt").write_text(ip)
    return crt, key


def main():
    handler = partial(Handler, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), handler)
    print(f"desktop:  http://127.0.0.1:{HTTP_PORT}/", flush=True)
    if "--no-https" not in sys.argv:
        ip = lan_ip()
        try:
            crt, key = ensure_cert(ip)
            httpsd = http.server.ThreadingHTTPServer(("0.0.0.0", HTTPS_PORT), handler)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(crt, key)
            httpsd.socket = ctx.wrap_socket(httpsd.socket, server_side=True)
            threading.Thread(target=httpsd.serve_forever, daemon=True).start()
            print(f"quest 3:  https://{ip}:{HTTPS_PORT}/   (same Wi-Fi; accept the certificate warning)", flush=True)
        except Exception as exc:  # HTTPS is optional; desktop keeps working
            print(f"HTTPS disabled: {exc}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
