/**
 * The application's top-level navigation.
 *
 * React Aria's Tabs give the behaviour an ad hoc row of buttons does not: arrow-key movement
 * within the tab list, one tab stop for the whole set, `aria-selected` and the panel
 * relationship maintained for us, and the selected tab announced as selected rather than merely
 * looking different.
 *
 * Visually it stays what QBSheet desktop navigation is — a row of labels with an underline on
 * the current one. It is not a pill switcher and it is not a segmented control.
 */

import type { ReactNode } from 'react';
import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  type Key,
} from 'react-aria-components';

export interface TabsProps {
  'aria-label': string;
  selectedKey: string;
  onSelectionChange: (key: string) => void;
  children: ReactNode;
  className?: string;
}

export function Tabs({ selectedKey, onSelectionChange, children, className, ...props }: TabsProps) {
  return (
    <AriaTabs
      aria-label={props['aria-label']}
      selectedKey={selectedKey}
      onSelectionChange={(key: Key) => onSelectionChange(String(key))}
      className={['qbs-tabs', className].filter(Boolean).join(' ')}
    >
      {children}
    </AriaTabs>
  );
}

export function TabList({ 'aria-label': label, children }: { 'aria-label': string; children: ReactNode }) {
  return (
    <AriaTabList aria-label={label} className="qbs-tabs__list">
      {children}
    </AriaTabList>
  );
}

export function Tab({ id, children }: { id: string; children: ReactNode }) {
  return (
    <AriaTab id={id} className="qbs-tabs__tab">
      {children}
    </AriaTab>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <AriaTabPanel id={id} className="qbs-tabs__panel">
      {children}
    </AriaTabPanel>
  );
}
