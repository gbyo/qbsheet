# Prepare a device

Do this before the tournament day. A browser problem is easy to fix on a quiet afternoon. It is hard
to fix in a room with two teams and a moderator who waits.

Do these steps on every device that a room will use.

## Step 1. Open the device check

1. Open QBSheet.
2. Select **Check this device** at the top of the start screen.

The screen reads **Device readiness**. QBSheet groups the results into three sections.

## Step 2. Fix the required checks

These checks must pass. A failure here can lose a game.

| Check | A pass means | A failure means |
| --- | --- | --- |
| **Game storage** | The browser can write to IndexedDB. A saved game survives a restart. | A closed tab can lose the game. |
| **Emergency journal** | The browser can write the event journal to `localStorage`. | The synchronous recovery journal is not reliable. |
| **Backup downloads** | A test file downloaded. | The browser blocks downloads. You cannot save a QBJ backup. |

QBSheet cannot see the end of a browser download by itself. So the download check asks you a
question. Select the test action, then answer whether the file `qbsheet-download-test.txt` arrived.

A private browser window and a strict content setting are the two common causes of a storage
failure. Use a normal window. Allow site data for the QBSheet address.

## Step 3. Read the recommended checks

These checks do not stop a game. Fix them anyway on a tournament device.

| Check | Why it matters |
| --- | --- |
| **Installed app** | An installed application starts faster and hides the browser controls. |
| **Offline app** | The service worker lets QBSheet start with no network. Stay online and reload once before the event. |
| **Protected storage** | The browser marks the QBSheet data persistent. The browser then does not delete the data for space. |
| **Duplicate-tab guard** | QBSheet can warn you when the same game is open in a second live tab. |

## Step 4. Check connected scoring

Do this section only when the room will connect to tournament control software.

| Check | Note |
| --- | --- |
| **Secure browser context** | A page outside a secure context loses browser security features. |
| **Local network access** | Chrome and Edge need permission to reach a server on the local network. |
| **Current network** | The browser reports a network connection now. |

Then test the server:

1. Type the address of the tournament control server in the field under **Tournament control**.
2. Run the test.
3. Read the result.

**Important:** Safari cannot use connected scoring against a local network server over the current
HTTPS-to-HTTP path. Use Chrome or Edge for a connected room. Safari is acceptable for a file-only
room.

## Step 5. Install QBSheet on the device

QBSheet is a progressive web application. An installed copy starts without a network connection.

1. Open QBSheet in Chrome or Edge while the device is online.
2. Use the install action in the browser.
3. Open the installed application, then reload it once.
4. Run the device check again. **Offline app** must now pass.

## A short checklist for the tournament morning

1. Open the installed application.
2. Confirm that the start screen appears with no network connection.
3. Confirm that no red storage warning appears.
4. Download one test file.
5. For a connected room, pair the room and read the assignment.

## Related pages

- [Start here](Start-here)
- [Score a connected game](Score-a-connected-game)
- [Troubleshooting](Troubleshooting)
- [Install and host](Install-and-host)
