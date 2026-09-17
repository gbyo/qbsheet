/**
 * `@qbsheet/ui` — QBSheet's shared design tokens and interaction primitives.
 *
 * QBSheet Scorer is the reference visual implementation. Shared controls use its canonical token
 * layer; applications retain their own layout and only promote behavior that truly has multiple
 * consumers.
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
