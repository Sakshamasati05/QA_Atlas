import http.server
import socketserver
import os
import sys

PORT = 8000

# Go to directory of this script to ensure relative paths work
script_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(script_dir)

Handler = http.server.SimpleHTTPRequestHandler

class QuietHandler(Handler):
    # Disable normal logs to avoid clutter, keep only errors
    def log_message(self, format, *args):
        pass

print(f"Starting server at http://localhost:{PORT}")
print("Press Ctrl+C to stop.")

try:
    with socketserver.TCPServer(("", PORT), QuietHandler) as httpd:
        httpd.serve_forever()
except KeyboardInterrupt:
    print("\nServer stopped.")
    sys.exit(0)
except Exception as e:
    print(f"Error starting server: {e}")
    sys.exit(1)
