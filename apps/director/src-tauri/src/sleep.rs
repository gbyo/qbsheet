//! OS sleep-prevention guard for the native QBTCP server lifetime (#745).
//!
//! While native QBTCP is serving rooms, Director is the tournament's LAN
//! service: an ordinary idle-system sleep would take every room offline at
//! once. This module holds that assertion behind a small RAII guard whose
//! lifetime is tied to the QBTCP serve task, using the supported native
//! mechanism per platform instead of timers or synthetic input:
//!
//! - macOS: `caffeinate -i` (idle-system sleep only; display sleep is left
//!   alone because `-d` is never passed).
//! - Linux: `systemd-inhibit` blocking `sleep`/`idle` while a `sleep` child
//!   runs. Desktops without logind surface acquisition failure, which the
//!   caller reports as a manual-workaround warning instead of protection.
//! - Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`
//!   for the process, cleared when the guard drops.
//!
//! Dropping the guard always releases the assertion: Unix guards kill the
//! inhibitor child, and the Windows guard clears the execution state. The
//! serve task owns the guard, so normal stop, task abort, and unexpected
//! task exit all release it without a separate shutdown path.

use std::io;
use std::process::{Child, Command, Stdio};

use thiserror::Error;

/// Actionable warning surfaced when keep-awake protection cannot be held.
/// QBTCP keeps running; the operator must disable sleep manually.
pub const SLEEP_WARNING: &str =
    "Director could not prevent this computer from sleeping. Disable automatic sleep while QBTCP is running.";

/// Observable keep-awake state exported through `ServerStatus` so Director
/// diagnostics can show whether host sleep protection is active (#745).
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepPreventionStatus {
    /// True only while the serve task owns a live OS assertion.
    pub active: bool,
    /// Set when protection was requested but could not be acquired. QBTCP
    /// itself keeps running; the operator must disable sleep manually.
    pub warning: Option<String>,
}

/// Variants are constructed per platform (`Unsupported` off unix/windows,
/// `Rejected` on Windows only), so every single-platform build sees some
/// variant as dead code.
#[allow(dead_code)]
#[derive(Debug, Error)]
pub enum SleepGuardError {
    #[error("host sleep prevention is not supported on this platform ({platform})")]
    Unsupported { platform: &'static str },
    #[error("could not start host sleep prevention ({command}): {source}")]
    Spawn {
        command: String,
        #[source]
        source: io::Error,
    },
    #[error("host sleep prevention request was rejected by the OS: {0}")]
    Rejected(String),
}

/// Spawns the platform inhibitor process. Injected so lifecycle tests can
/// count acquisitions and force failures without touching the OS (#745).
pub(crate) trait SleepLauncher: Send + Sync {
    fn launch(&self) -> io::Result<Child>;
    fn description(&self) -> &'static str;
}

/// Production launcher: the OS-supported inhibitor for this platform.
pub(crate) struct PlatformSleepLauncher;

#[cfg(target_os = "macos")]
impl SleepLauncher for PlatformSleepLauncher {
    fn launch(&self) -> io::Result<Child> {
        // `-i` prevents idle system sleep on AC and battery; no `-d`, so
        // display sleep is unaffected.
        Command::new("caffeinate")
            .arg("-i")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }

    fn description(&self) -> &'static str {
        "caffeinate -i"
    }
}

#[cfg(target_os = "linux")]
impl SleepLauncher for PlatformSleepLauncher {
    fn launch(&self) -> io::Result<Child> {
        Command::new("systemd-inhibit")
            .args([
                "--what=sleep:idle",
                "--who=QBSheet Director",
                "--why=QBTCP is serving scoring rooms",
                "--mode=block",
                "sleep",
                "infinity",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }

    fn description(&self) -> &'static str {
        "systemd-inhibit"
    }
}

#[cfg(windows)]
impl SleepLauncher for PlatformSleepLauncher {
    fn launch(&self) -> io::Result<Child> {
        // Windows holds the assertion via SetThreadExecutionState instead of
        // a child process; see QbtcpSleepGuard::acquire_with.
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "windows uses SetThreadExecutionState",
        ))
    }

    fn description(&self) -> &'static str {
        "SetThreadExecutionState"
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
impl SleepLauncher for PlatformSleepLauncher {
    fn launch(&self) -> io::Result<Child> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no sleep inhibitor for this platform",
        ))
    }

    fn description(&self) -> &'static str {
        "unsupported platform"
    }
}

/// RAII hold on host sleep prevention. The serve task owns this value, so
/// every task ending (stop, abort, unexpected exit) releases the OS
/// assertion when the value drops.
pub struct QbtcpSleepGuard {
    #[cfg(unix)]
    child: Child,
    #[cfg(windows)]
    _power: WindowsPowerHold,
}

impl QbtcpSleepGuard {
    pub fn acquire(launcher: &dyn SleepLauncher) -> Result<Self, SleepGuardError> {
        Self::acquire_with(launcher)
    }

    pub(crate) fn acquire_with(launcher: &dyn SleepLauncher) -> Result<Self, SleepGuardError> {
        #[cfg(windows)]
        {
            let _ = launcher;
            WindowsPowerHold::acquire().map(|hold| Self { _power: hold })
        }
        #[cfg(unix)]
        {
            let command = launcher.description().to_owned();
            let child = launcher
                .launch()
                .map_err(|source| SleepGuardError::Spawn { command, source })?;
            Ok(Self { child })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = launcher;
            Err(SleepGuardError::Unsupported {
                platform: std::env::consts::OS,
            })
        }
    }
}

impl Drop for QbtcpSleepGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            // Best effort: the process is exiting or already exited anyway.
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(windows)]
struct WindowsPowerHold;

#[cfg(windows)]
impl WindowsPowerHold {
    fn acquire() -> Result<Self, SleepGuardError> {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
        };
        // SAFETY: SetThreadExecutionState with valid flags has no
        // memory-safety contract; a zero return means the request failed.
        let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        if previous == 0 {
            return Err(SleepGuardError::Rejected(
                "SetThreadExecutionState refused ES_SYSTEM_REQUIRED".to_owned(),
            ));
        }
        Ok(Self)
    }
}

#[cfg(windows)]
impl Drop for WindowsPowerHold {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
        // SAFETY: same contract as acquire; the return value carries no
        // failure mode that outlives a dying process.
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// Fake launcher: counts acquisitions, optionally fails, and spawns a
    /// harmless `sleep` child so guard Drop/kill paths run for real.
    pub(crate) struct FakeSleepLauncher {
        pub acquisitions: AtomicUsize,
        pub failures: Mutex<usize>,
    }

    impl FakeSleepLauncher {
        pub fn succeeding() -> Self {
            Self {
                acquisitions: AtomicUsize::new(0),
                failures: Mutex::new(0),
            }
        }

        pub fn failing(times: usize) -> Self {
            Self {
                acquisitions: AtomicUsize::new(0),
                failures: Mutex::new(times),
            }
        }

        pub fn acquired(&self) -> usize {
            self.acquisitions.load(Ordering::SeqCst)
        }
    }

    impl SleepLauncher for FakeSleepLauncher {
        fn launch(&self) -> io::Result<Child> {
            self.acquisitions.fetch_add(1, Ordering::SeqCst);
            let mut failures = self.failures.lock().expect("fake lock");
            if *failures > 0 {
                *failures -= 1;
                return Err(io::Error::other("fake inhibitor unavailable"));
            }
            drop(failures);
            Command::new("sleep")
                .arg("60")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
        }

        fn description(&self) -> &'static str {
            "fake-sleep-inhibitor"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::FakeSleepLauncher;
    use super::*;

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        // `kill -0` probes existence without delivering a signal.
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    #[test]
    fn dropping_the_guard_kills_the_inhibitor_child() {
        let launcher = FakeSleepLauncher::succeeding();
        let guard = QbtcpSleepGuard::acquire_with(&launcher).expect("guard acquires");
        assert_eq!(launcher.acquired(), 1);
        let pid = guard.child.id();
        assert!(process_exists(pid), "inhibitor child runs while held");
        drop(guard);
        let mut gone = false;
        for _ in 0..100 {
            if !process_exists(pid) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(gone, "dropping the guard must kill the inhibitor child");
    }

    #[test]
    fn launcher_failure_is_an_acquire_error() {
        let launcher = FakeSleepLauncher::failing(1);
        let error = match QbtcpSleepGuard::acquire_with(&launcher) {
            Ok(_) => panic!("acquire must fail"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("fake inhibitor unavailable"));
    }
}
