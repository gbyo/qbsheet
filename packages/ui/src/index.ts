/**
 * `@qbsheet/ui` — QBSheet's shared design tokens and interaction primitives.
 *
 * The smallest useful version of the shared layer: enough for QBBridge to stop carrying a visual
 * system of its own, and shaped so the next surface adds components here rather than beside it.
 *
 * Behaviour comes from `react-aria-components`; appearance comes entirely from
 * `tokens.css` + `components.css`. No third-party theme is imported, and nothing here should
 * make a QBSheet surface look like somebody else's design system.
 *
 * Deliberately absent: wrappers for markup that native HTML already does correctly. A section, a
 * definition list, a table and a static status line are written as themselves.
 */

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './components/Button';
export { ConfirmDialog, type ConfirmDialogProps } from './components/Dialog';
export { Notice, type NoticeProps, type Tone } from './components/Notice';
export { StatusBadge, type StatusBadgeProps } from './components/StatusBadge';
export { Tab, TabList, TabPanel, Tabs, type TabsProps } from './components/Tabs';
export { TextField, type TextFieldProps } from './components/TextField';
export { TeamComboBox, type TeamComboBoxProps, type TeamOption } from './components/TeamComboBox';
