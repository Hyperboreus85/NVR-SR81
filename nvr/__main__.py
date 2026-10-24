import os
import uvicorn


def main():
    # A single process owns the camera workers and SQLite index.
    uvicorn.run("nvr.app:create_app", factory=True,
                host=os.getenv("NVR_HOST", "127.0.0.1"),
                port=int(os.getenv("NVR_PORT", "8080")), workers=1,
                access_log=False, ws="wsproto", ws_max_size=65536)


if __name__ == "__main__":
    main()
