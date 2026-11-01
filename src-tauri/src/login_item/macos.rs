//! The app itself as a login item through `SMAppService` (macOS 13+). It appears under its own name
//! in System Settings › General › Login Items, and no launch agent file is written.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};
use objc2_service_management::{SMAppService, SMAppServiceStatus};

/// Four-character codes of the Apple Event Manager (`AERegistry.h`, `AEDataModel.h`).
const K_AE_OPEN_APPLICATION: u32 = u32::from_be_bytes(*b"oapp");
const KEY_AE_PROP_DATA: u32 = u32::from_be_bytes(*b"prdt");
const KEY_AE_LAUNCHED_AS_LOG_IN_ITEM: u32 = u32::from_be_bytes(*b"lgit");

fn service() -> Retained<SMAppService> {
    // SAFETY: a class method without arguments that returns the service for the running bundle.
    unsafe { SMAppService::mainAppService() }
}

fn status(service: &SMAppService) -> SMAppServiceStatus {
    // SAFETY: a property read without arguments.
    unsafe { service.status() }
}

pub fn is_enabled() -> bool {
    status(&service()) == SMAppServiceStatus::Enabled
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let service = service();
    // SAFETY: both methods take no arguments and report failure through the returned NSError.
    let result = unsafe {
        if enabled {
            service.registerAndReturnError()
        } else {
            service.unregisterAndReturnError()
        }
    };
    // A user who turned Snipvero off in Login Items must allow it there again; no app can.
    if enabled && status(&service) == SMAppServiceStatus::RequiresApproval {
        // SAFETY: a class method without arguments.
        unsafe { SMAppService::openSystemSettingsLoginItems() };
        return Ok(());
    }
    result.map_err(|error| error.localizedDescription().to_string())
}

pub fn launched_at_login() -> bool {
    let Some(event) = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent() else {
        return false;
    };
    // SAFETY: `eventID` returns an `AEEventID` (UInt32) and `paramDescriptorForKeyword:` takes an
    // `AEKeyword` (UInt32) and returns a descriptor or nil. objc2-foundation binds them only with
    // the objc2-core-services crate, which nothing else here needs.
    let (event_id, launch): (u32, Option<Retained<NSAppleEventDescriptor>>) = unsafe {
        (
            msg_send![&*event, eventID],
            msg_send![&*event, paramDescriptorForKeyword: KEY_AE_PROP_DATA],
        )
    };
    is_login_item_launch(event_id, launch.map(|launch| launch.enumCodeValue()))
}

/// The open-application event the system sends a login item carries `keyAELaunchedAsLogInItem` as
/// its launch kind.
fn is_login_item_launch(event_id: u32, launch_kind: Option<u32>) -> bool {
    event_id == K_AE_OPEN_APPLICATION && launch_kind == Some(KEY_AE_LAUNCHED_AS_LOG_IN_ITEM)
}

#[cfg(test)]
mod tests {
    use super::{
        K_AE_OPEN_APPLICATION, KEY_AE_LAUNCHED_AS_LOG_IN_ITEM, KEY_AE_PROP_DATA,
        is_login_item_launch,
    };

    #[test]
    fn four_character_codes_match_the_sdk() {
        assert_eq!(K_AE_OPEN_APPLICATION, 0x6F61_7070);
        assert_eq!(KEY_AE_PROP_DATA, 0x7072_6474);
        assert_eq!(KEY_AE_LAUNCHED_AS_LOG_IN_ITEM, 0x6C67_6974);
    }

    #[test]
    fn only_an_open_event_marked_as_login_item_counts() {
        let reopen = u32::from_be_bytes(*b"rapp");
        let other_kind = u32::from_be_bytes(*b"lnch");
        assert!(is_login_item_launch(
            K_AE_OPEN_APPLICATION,
            Some(KEY_AE_LAUNCHED_AS_LOG_IN_ITEM)
        ));
        assert!(!is_login_item_launch(K_AE_OPEN_APPLICATION, None));
        assert!(!is_login_item_launch(
            K_AE_OPEN_APPLICATION,
            Some(other_kind)
        ));
        assert!(!is_login_item_launch(
            reopen,
            Some(KEY_AE_LAUNCHED_AS_LOG_IN_ITEM)
        ));
    }

    /// A test process is not launched by the system, so it must never count as a login launch.
    #[test]
    fn a_test_run_is_not_a_login_launch() {
        assert!(!super::launched_at_login());
    }
}
