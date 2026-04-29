import React from 'react';
import TabPanelList from 'rc-tabs/es/TabPanelList';

// Shim for the deprecated `SwipeableTabContent` component that existed in
// rc-tabs v9/10. We forward everything to the new `TabPanelList` so existing
// render functions (e.g. `renderTabContent={() => <TabContent />}`) keep
// working after the upgrade to rc-tabs v12.

const SwipeableTabContent = ({ animated, ...restProps }) => {
  const mergedAnimated = animated || { inkBar: true, tabPane: true };
  return <TabPanelList animated={mergedAnimated} {...restProps} />;
};

export default SwipeableTabContent; 