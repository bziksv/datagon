import React from 'react';
import Tabs from 'rc-tabs/es/Tabs';
import TabPane from 'rc-tabs/es/TabPanelList/TabPane';

// This wrapper restores the legacy named export `{ TabPane }` that was removed
// in rc-tabs v12+. Existing code expects to be able to do:
//   import Tabs, { TabPane } from 'rc-tabs';
// After aliasing, those imports will resolve to this module, which re-exports
// the TabPane component as a named export.

function LegacyTabs({ renderTabContent, ...rest }) {
  // `renderTabContent` existed in rc-tabs <=10. In v15 the component tree was
  // redesigned, and the prop is no longer used. We simply swallow it to avoid
  // passing an unknown attribute down to the DOM and to silence React 19
  // warnings.
  return <Tabs {...rest} />;
}

// Preserve static reference so consumers can access `<Tabs.TabPane>` as well.
LegacyTabs.TabPane = TabPane;

export { TabPane };
export default LegacyTabs; 