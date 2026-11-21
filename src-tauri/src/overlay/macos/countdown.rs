//! A native, click-through, nonactivating indicator. Reusing the opaque capture webviews here
//! would cover the live app or take focus, dismissing the dropdown the user wants to capture.
//! The same panel shows the border of a running recording (ADR-037), in red. A recording also gets
//! a small separate panel next to it with the clock, a **Stop** button and the shortcut that stops
//! it: unlike the border, that panel takes clicks, but it never activates Snipvero, so the app
//! being recorded keeps its focus. Both are Snipvero windows and so never in the video.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSBackingStoreType, NSBox, NSBoxType, NSButton, NSColor, NSFont, NSPanel, NSScreen,
    NSScreenSaverWindowLevel, NSTextAlignment, NSTextField, NSTitlePosition, NSView,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};

use crate::geometry::{LogicalRect, PixelRect, countdown_layout, recording_layout};
use crate::i18n::tr;

struct Indicator {
    session: u64,
    panel: Retained<NSPanel>,
    border: Retained<NSBox>,
    label: Retained<NSTextField>,
    /// A recording's control strip; none for the countdown.
    strip: Option<Strip>,
}

/// The recording's clickable panel and the object its button calls.
struct Strip {
    panel: Retained<NSPanel>,
    _target: Retained<StopTarget>,
}

struct StopIvars {
    on_stop: Box<dyn Fn()>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this class has no Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = StopIvars]
    struct StopTarget;

    unsafe impl NSObjectProtocol for StopTarget {}

    impl StopTarget {
        #[unsafe(method(stop:))]
        fn stop(&self, _sender: Option<&AnyObject>) {
            (self.ivars().on_stop)();
        }
    }
);

impl StopTarget {
    fn new(mtm: MainThreadMarker, on_stop: Box<dyn Fn()>) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(StopIvars { on_stop });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
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

/// The countdown's colour, and the recording's.
const COUNTDOWN: (f64, f64, f64) = (0.39, 0.40, 0.95);
const RECORDING: (f64, f64, f64) = (0.92, 0.22, 0.22);

fn countdown_text(seconds: u64) -> String {
    tr!(
        format!("Capture in {seconds}s"),
        format!("{seconds} sn içinde yakalanacak")
    )
}

pub fn show_countdown(
    session: u64,
    bounds: LogicalRect,
    region: PixelRect,
    frame: (u32, u32),
    seconds: u64,
) -> Result<(), String> {
    show_indicator(
        session,
        bounds,
        region,
        frame,
        &countdown_text(seconds),
        COUNTDOWN,
    )
}

/// Shows the recording indicator, or only changes its clock when `session` already has one. The
/// strip beside the border holds the clock, a **Stop** button that calls `on_stop`, and `hint`
/// (how else to stop, for example the capture shortcut) when there is one.
pub fn show_or_update_recording(
    session: u64,
    bounds: LogicalRect,
    region: PixelRect,
    frame: (u32, u32),
    text: &str,
    hint: Option<&str>,
    on_stop: Box<dyn Fn()>,
) -> Result<(), String> {
    let shown = INDICATOR.with_borrow(|current| {
        current.as_ref().filter(|i| i.session == session).map(|i| {
            i.label.setStringValue(&NSString::from_str(text));
        })
    });
    if shown.is_some() {
        return Ok(());
    }
    let mtm =
        MainThreadMarker::new().ok_or("the indicator must be configured on the main thread")?;
    let primary_height = primary_height(mtm)?;
    let accent = color(RECORDING);

    // The strip's contents first: their size decides the strip's size, and so its place.
    let label = NSTextField::labelWithString(&NSString::from_str("● 00:00"), mtm);
    label.setTextColor(Some(&NSColor::whiteColor()));
    label.setFont(Some(&NSFont::boldSystemFontOfSize(13.0)));
    label.sizeToFit();
    // The widest clock "00:00" plus a little: the digits are not all equally wide, and the strip
    // must not change size every second.
    let mut label_frame = label.frame();
    label_frame.size.width += 6.0;
    label.setFrame(label_frame);
    label.setStringValue(&NSString::from_str(text));
    let target = StopTarget::new(mtm, on_stop);
    // SAFETY: `stop:` is implemented by `StopTarget`, which the strip keeps alive.
    let button = unsafe {
        NSButton::buttonWithTitle_target_action(
            &NSString::from_str(tr!("Stop", "Durdur")),
            Some(&target),
            Some(sel!(stop:)),
            mtm,
        )
    };
    // A window that is not key draws its bordered buttons dimmed, which disappears on red. The
    // button is drawn flat here instead, red on a white pill (`stop_pill` below).
    button.setBordered(false);
    button.setContentTintColor(Some(&accent));
    button.sizeToFit();
    // Room around the word, so the white pill is a button and not a highlight.
    let fitted = button.frame().size;
    button.setFrameSize(NSSize::new(fitted.width + 18.0, 22.0));
    let hint_label = hint.map(|hint| {
        let field = NSTextField::labelWithString(&NSString::from_str(hint), mtm);
        field.setTextColor(Some(&NSColor::colorWithSRGBRed_green_blue_alpha(
            1.0, 1.0, 1.0, 0.85,
        )));
        field.setFont(Some(&NSFont::systemFontOfSize(11.0)));
        field.sizeToFit();
        field
    });

    const PAD: f64 = 10.0;
    const GAP: f64 = 8.0;
    let (label_size, button_size) = (label.frame().size, button.frame().size);
    let hint_width = hint_label
        .as_ref()
        .map_or(0.0, |field| GAP + field.frame().size.width);
    let height = (button_size.height + 8.0).max(30.0);
    let width = PAD + label_size.width + GAP + button_size.width + hint_width + PAD;
    let (border_rect, strip_rect) = recording_layout(region, bounds, frame, (width, height));

    let (panel, border) = base_panel(mtm, bounds, primary_height, border_rect, &accent);
    // The strip's own panel, in desktop coordinates; clicks reach it, focus never does.
    let global = LogicalRect {
        x: bounds.x + strip_rect.x,
        y: bounds.y + strip_rect.y,
        width: strip_rect.width,
        height: strip_rect.height,
    };
    let strip_panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        NSPanel::alloc(mtm),
        rect(global, primary_height),
        NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
        NSBackingStoreType::Buffered,
        false,
    );
    configure_panel(&strip_panel, false);
    strip_panel.setHasShadow(true);
    let size = NSSize::new(strip_rect.width, strip_rect.height);
    let content = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), size),
    );
    let background =
        NSBox::initWithFrame(NSBox::alloc(mtm), NSRect::new(NSPoint::new(0.0, 0.0), size));
    background.setBoxType(NSBoxType::Custom);
    background.setTitlePosition(NSTitlePosition::NoTitle);
    background.setBorderWidth(0.0);
    background.setCornerRadius(8.0);
    background.setFillColor(&accent);
    content.addSubview(&background);
    let centered = |height: f64| (strip_rect.height - height) / 2.0;
    let mut x = PAD;
    label.setFrameOrigin(NSPoint::new(x, centered(label_size.height)));
    content.addSubview(&label);
    x += label_size.width + GAP;
    button.setFrameOrigin(NSPoint::new(x, centered(button_size.height)));
    let stop_pill = NSBox::initWithFrame(
        NSBox::alloc(mtm),
        NSRect::new(NSPoint::new(x, centered(button_size.height)), button_size),
    );
    stop_pill.setBoxType(NSBoxType::Custom);
    stop_pill.setTitlePosition(NSTitlePosition::NoTitle);
    stop_pill.setBorderWidth(0.0);
    stop_pill.setCornerRadius(6.0);
    stop_pill.setFillColor(&NSColor::whiteColor());
    content.addSubview(&stop_pill);
    content.addSubview(&button);
    if let Some(field) = &hint_label {
        x += button_size.width + GAP;
        field.setFrameOrigin(NSPoint::new(x, centered(field.frame().size.height)));
        content.addSubview(field);
    }
    strip_panel.setContentView(Some(&content));
    install(
        session,
        panel,
        border,
        label,
        Some(Strip {
            panel: strip_panel,
            _target: target,
        }),
    );
    Ok(())
}

fn color(rgb: (f64, f64, f64)) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(rgb.0, rgb.1, rgb.2, 1.0)
}

fn primary_height(mtm: MainThreadMarker) -> Result<f64, String> {
    NSScreen::screens(mtm)
        .firstObject()
        .map(|s| s.frame().size.height)
        .ok_or_else(|| "no screens".to_string())
}

/// The settings both panels share: above everything, on every Space, never the key window, and
/// not in the window cycle.
fn configure_panel(panel: &NSPanel, click_through: bool) {
    // We own the panel through Retained, not AppKit's release-on-close mechanism.
    unsafe {
        panel.setReleasedWhenClosed(false);
    }
    panel.setOpaque(false);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setHasShadow(false);
    panel.setIgnoresMouseEvents(click_through);
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
}

/// The click-through panel over a whole display with the coloured border around the region.
fn base_panel(
    mtm: MainThreadMarker,
    bounds: LogicalRect,
    primary_height: f64,
    border_rect: LogicalRect,
    accent: &NSColor,
) -> (Retained<NSPanel>, Retained<NSBox>) {
    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        NSPanel::alloc(mtm),
        rect(bounds, primary_height),
        NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
        NSBackingStoreType::Buffered,
        false,
    );
    configure_panel(&panel, true);
    let content = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(bounds.width, bounds.height),
        ),
    );
    let border = NSBox::initWithFrame(NSBox::alloc(mtm), rect(border_rect, bounds.height));
    border.setBoxType(NSBoxType::Custom);
    border.setTitlePosition(NSTitlePosition::NoTitle);
    border.setBorderWidth(2.0);
    border.setBorderColor(accent);
    border.setFillColor(&NSColor::clearColor());
    content.addSubview(&border);
    panel.setContentView(Some(&content));
    (panel, border)
}

/// Replaces the current indicator. `orderFrontRegardless` never activates Snipvero or steals
/// keyboard focus, unlike makeKeyAndOrderFront.
fn install(
    session: u64,
    panel: Retained<NSPanel>,
    border: Retained<NSBox>,
    label: Retained<NSTextField>,
    strip: Option<Strip>,
) {
    INDICATOR.with_borrow_mut(|current| {
        if let Some(old) = current.take() {
            old.hide();
        }
        panel.orderFrontRegardless();
        if let Some(strip) = &strip {
            strip.panel.orderFrontRegardless();
        }
        *current = Some(Indicator {
            session,
            panel,
            border,
            label,
            strip,
        });
    });
}

impl Indicator {
    fn hide(&self) {
        self.panel.orderOut(None);
        if let Some(strip) = &self.strip {
            strip.panel.orderOut(None);
        }
    }
}

fn show_indicator(
    session: u64,
    bounds: LogicalRect,
    region: PixelRect,
    frame: (u32, u32),
    text: &str,
    accent: (f64, f64, f64),
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("countdown must be configured on the main thread")?;
    let primary_height = primary_height(mtm)?;
    let (border_rect, badge_rect) = countdown_layout(region, bounds, frame);
    let accent = color(accent);
    let (panel, border) = base_panel(mtm, bounds, primary_height, border_rect, &accent);
    let badge = NSBox::initWithFrame(NSBox::alloc(mtm), rect(badge_rect, bounds.height));
    badge.setBoxType(NSBoxType::Custom);
    badge.setTitlePosition(NSTitlePosition::NoTitle);
    badge.setBorderWidth(0.0);
    badge.setCornerRadius(6.0);
    badge.setFillColor(&accent);
    let label = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    let mut label_rect = rect(badge_rect, bounds.height);
    label_rect.origin.y += 5.0;
    label_rect.size.height -= 5.0;
    label.setFrame(label_rect);
    label.setTextColor(Some(&NSColor::whiteColor()));
    label.setFont(Some(&NSFont::boldSystemFontOfSize(13.0)));
    label.setAlignment(NSTextAlignment::Center);
    if let Some(content) = panel.contentView() {
        content.addSubview(&badge);
        content.addSubview(&label);
    }
    install(session, panel, border, label, None);
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
                .setStringValue(&NSString::from_str(&countdown_text(seconds)));
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
            indicator.hide();
        }
    });
}
