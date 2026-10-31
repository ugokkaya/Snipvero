//! macOS window placement for overlays: above the menu bar and Dock, on every Space.

use std::ptr::NonNull;

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplicationDidChangeScreenParametersNotification, NSNormalWindowLevel, NSScreen,
    NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior,
};
use objc2_core_graphics::CGEvent;
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSOperationQueue, NSPoint, NSRect, NSSize,
};
use tauri::WebviewWindow;

use crate::geometry::LogicalRect;

/// Raises the overlay above the menu bar, lets it appear over full-screen apps, and makes it
/// cover `bounds` exactly. Tauri's `always_on_top` level is below the menu bar.
pub fn raise(window: &WebviewWindow, bounds: LogicalRect) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("overlay must be configured on the main thread")?;
    // Cocoa frames are relative to the primary display (the first screen), y-up.
    let primary_height = NSScreen::screens(mtm)
        .firstObject()
        .map(|screen| screen.frame().size.height)
        .ok_or("no screens")?;
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    // SAFETY: Tauri returns this window's live NSWindow, and we are on the main thread.
    let ns_window = unsafe { &*ptr.cast::<NSWindow>() };
    ns_window.setLevel(NSScreenSaverWindowLevel);
    ns_window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    ns_window.setHasShadow(false);
    ns_window.setFrame_display(
        NSRect::new(
            NSPoint::new(bounds.x, bounds.cocoa_y(primary_height)),
            NSSize::new(bounds.width, bounds.height),
        ),
        true,
    );
    Ok(())
}

/// Lowers a shown overlay to the normal window level while a dialog is open, or raises it again.
/// AppKit runs the save panel at the modal-panel level, far below `NSScreenSaverWindowLevel`.
pub fn set_raised(window: &WebviewWindow, raised: bool) -> Result<(), String> {
    MainThreadMarker::new().ok_or("overlay must be configured on the main thread")?;
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    // SAFETY: Tauri returns this window's live NSWindow, and we are on the main thread.
    let ns_window = unsafe { &*ptr.cast::<NSWindow>() };
    ns_window.setLevel(if raised {
        NSScreenSaverWindowLevel
    } else {
        NSNormalWindowLevel
    });
    Ok(())
}

/// Calls `handler` on the main thread whenever the display arrangement changes (a display
/// connected, removed, rearranged or set to another resolution). Observes for the app's lifetime.
pub fn observe_display_changes(handler: impl Fn() + 'static) {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| handler());
    // SAFETY: an AppKit notification name constant; the main queue runs the block on the main
    // thread, where AppKit posts this notification anyway.
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidChangeScreenParametersNotification),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    // Never removed: the observation lasts as long as the app.
    std::mem::forget(observer);
}

/// Bounds of every connected display in desktop points (CoreGraphics global space, y-down, the
/// space of `SCDisplay.frame`). Main thread only.
pub fn display_bounds() -> Option<Vec<LogicalRect>> {
    let mtm = MainThreadMarker::new()?;
    let screens = NSScreen::screens(mtm);
    // Cocoa frames are relative to the primary display (the first screen), y-up.
    let primary_height = screens.firstObject()?.frame().size.height;
    Some(
        screens
            .iter()
            .map(|screen| {
                let frame = screen.frame();
                LogicalRect {
                    x: frame.origin.x,
                    y: primary_height - frame.origin.y - frame.size.height,
                    width: frame.size.width,
                    height: frame.size.height,
                }
            })
            .collect(),
    )
}

/// Cursor position in desktop coordinates (CoreGraphics global space, y-down).
pub fn cursor_location() -> Option<(f64, f64)> {
    let event = CGEvent::new(None)?;
    let point = CGEvent::location(Some(&event));
    Some((point.x, point.y))
}
