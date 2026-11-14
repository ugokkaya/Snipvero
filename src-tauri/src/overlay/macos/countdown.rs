//! A native, click-through, nonactivating indicator. Reusing the opaque capture webviews here
//! would cover the live app or take focus, dismissing the dropdown the user wants to capture.

use std::cell::RefCell;

use objc2::{MainThreadMarker, MainThreadOnly, rc::Retained};
use objc2_app_kit::{
    NSBackingStoreType, NSBox, NSBoxType, NSColor, NSFont, NSPanel, NSScreen,
    NSScreenSaverWindowLevel, NSTextAlignment, NSTextField, NSTitlePosition, NSView,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

use crate::geometry::{LogicalRect, PixelRect, countdown_layout};

struct Indicator {
    session: u64,
    panel: Retained<NSPanel>,
    border: Retained<NSBox>,
    label: Retained<NSTextField>,
}

thread_local! {
    // AppKit objects never leave the main thread. A session token makes late ticks harmless.
    static INDICATOR: RefCell<Option<Indicator>> = const { RefCell::new(None) };
}

fn rect(rect: LogicalRect, height: f64) -> NSRect {
    NSRect::new(
        NSPoint::new(rect.x, rect.cocoa_y(height)),
        NSSize::new(rect.width, rect.height),
    )
}

pub fn show_countdown(
    session: u64,
    bounds: LogicalRect,
    region: PixelRect,
    frame: (u32, u32),
    seconds: u64,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("countdown must be configured on the main thread")?;
    let primary_height = NSScreen::screens(mtm)
        .firstObject()
        .map(|s| s.frame().size.height)
        .ok_or("no screens")?;
    let (border_rect, badge_rect) = countdown_layout(region, bounds, frame);
    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        NSPanel::alloc(mtm),
        rect(bounds, primary_height),
        NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
        NSBackingStoreType::Buffered,
        false,
    );
    // We own the panel through Retained, not AppKit's release-on-close mechanism.
    unsafe {
        panel.setReleasedWhenClosed(false);
    }
    panel.setOpaque(false);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setHasShadow(false);
    panel.setIgnoresMouseEvents(true);
    panel.setHidesOnDeactivate(false);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setExcludedFromWindowsMenu(true);
    panel.setLevel(NSScreenSaverWindowLevel);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    let content = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(bounds.width, bounds.height),
        ),
    );
    let accent = NSColor::colorWithSRGBRed_green_blue_alpha(0.39, 0.40, 0.95, 1.0);
    let border = NSBox::initWithFrame(NSBox::alloc(mtm), rect(border_rect, bounds.height));
    border.setBoxType(NSBoxType::Custom);
    border.setTitlePosition(NSTitlePosition::NoTitle);
    border.setBorderWidth(2.0);
    border.setBorderColor(&accent);
    border.setFillColor(&NSColor::clearColor());
    content.addSubview(&border);

    let badge = NSBox::initWithFrame(NSBox::alloc(mtm), rect(badge_rect, bounds.height));
    badge.setBoxType(NSBoxType::Custom);
    badge.setTitlePosition(NSTitlePosition::NoTitle);
    badge.setBorderWidth(0.0);
    badge.setCornerRadius(6.0);
    badge.setFillColor(&accent);
    content.addSubview(&badge);
    let label =
        NSTextField::labelWithString(&NSString::from_str(&format!("Capture in {seconds}s")), mtm);
    let mut label_rect = rect(badge_rect, bounds.height);
    label_rect.origin.y += 5.0;
    label_rect.size.height -= 5.0;
    label.setFrame(label_rect);
    label.setTextColor(Some(&NSColor::whiteColor()));
    label.setFont(Some(&NSFont::boldSystemFontOfSize(13.0)));
    label.setAlignment(NSTextAlignment::Center);
    content.addSubview(&label);
    panel.setContentView(Some(&content));
    INDICATOR.with_borrow_mut(|current| {
        if let Some(old) = current.take() {
            old.panel.orderOut(None);
        }
        // Unlike makeKeyAndOrderFront, this never activates Snipvero or steals keyboard focus.
        panel.orderFrontRegardless();
        *current = Some(Indicator {
            session,
            panel,
            border,
            label,
        });
    });
    Ok(())
}

pub fn update_countdown(session: u64, seconds: u64, bright: bool) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    INDICATOR.with_borrow(|current| {
        if let Some(indicator) = current.as_ref().filter(|i| i.session == session) {
            indicator
                .label
                .setStringValue(&NSString::from_str(&format!("Capture in {seconds}s")));
            // Only the border pulses; the countdown stays legible and the live app stays clear.
            indicator
                .border
                .setAlphaValue(if bright { 1.0 } else { 0.3 });
        }
    });
}

pub fn hide_countdown(session: u64) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    INDICATOR.with_borrow_mut(|current| {
        if current.as_ref().is_some_and(|i| i.session == session)
            && let Some(indicator) = current.take()
        {
            indicator.panel.orderOut(None);
        }
    });
}
