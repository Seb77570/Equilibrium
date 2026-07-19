// Tiny HTTP server that serves the bundled Tauri frontend assets on
// 127.0.0.1:LOCAL_PORT. Used in release builds so the main webview's origin
// is `http://localhost:<port>` (sharing the `localhost` eTLD+1 with the
// user's project at localhost:3000) instead of `http://tauri.localhost`
// (which is a different site → iframe cookies blocked → login broken).
//
// Only compiled in release: in dev the frontend is already on localhost:4321
// (Next.js dev server) so the cookie problem doesn't exist.

use std::sync::OnceLock;

use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode, Uri},
    response::IntoResponse,
    routing::any,
    Router,
};
use tauri::{AppHandle, Manager};

// Port 0 = let the OS pick any free port. Windows reserves chunks of TCP
// ports for Hyper-V/WSL at every boot, and those ranges shift — pinning a
// constant means we get locked out at random and silently fall back to the
// tauri.localhost origin, which re-triggers the third-party cookie bug on
// the iframe login. The actual bound port is exposed via `bound_port()` so
// the caller can build the navigate URL.
const PREFERRED_PORT: u16 = 0;

// AppHandle is held in a OnceLock so the axum handlers (which run on a
// separate runtime) can resolve assets without taking a dependency on
// AppHandle in their function signature.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn start(app: &AppHandle) -> std::io::Result<u16> {
    if APP_HANDLE.set(app.clone()).is_err() {
        // Already started. We don't track the previously-bound port; the
        // caller's first call is the source of truth.
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "static_server already started",
        ));
    }

    let listener = std::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT))?;
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;

    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("static_server: failed to build tokio runtime");

        runtime.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener)
                .expect("static_server: failed to wrap TcpListener");
            let router = Router::new().fallback(any(handle));
            if let Err(e) = axum::serve(listener, router).await {
                eprintln!("static_server: serve error: {e}");
            }
        });
    });

    Ok(port)
}

async fn handle(uri: Uri) -> Response<Body> {
    let app = match APP_HANDLE.get() {
        Some(a) => a,
        None => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "app handle missing"),
    };

    // Tauri's resolver expects paths like "/index.html" (with leading slash).
    let path = uri.path();
    let candidates: Vec<String> = if path == "/" || path.is_empty() {
        vec!["/index.html".into()]
    } else {
        let trimmed = path.trim_end_matches('/');
        // Try literal, then `<path>.html`, then `<path>/index.html` — covers
        // Next.js static export's routing variants.
        vec![
            path.to_string(),
            format!("{trimmed}.html"),
            format!("{trimmed}/index.html"),
        ]
    };

    let resolver = app.asset_resolver();
    for candidate in &candidates {
        if let Some(asset) = resolver.get(candidate.clone()) {
            return asset_response(asset);
        }
    }

    // SPA fallback for unknown routes.
    if let Some(asset) = resolver.get("/index.html".to_string()) {
        return asset_response(asset);
    }

    error_response(StatusCode::NOT_FOUND, "asset not found")
}

fn asset_response(asset: tauri::Asset) -> Response<Body> {
    let mut response = Response::new(Body::from(asset.bytes));
    if let Ok(value) = HeaderValue::from_str(&asset.mime_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    // Avoid stale assets in WebView2 between rebuilds.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
    response
}

fn error_response(status: StatusCode, msg: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(msg.to_string()))
        .unwrap()
}
