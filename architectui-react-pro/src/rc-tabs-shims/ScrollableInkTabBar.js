import React from 'react';
import TabNavList from 'rc-tabs/es/TabNavList';

// This shim replicates the old `ScrollableInkTabBar` component that existed in
// rc-tabs v9/10. In v12 the public API changed, so we expose a thin wrapper
// that simply forwards all props to the new `TabNavList` implementation. This
// allows the legacy codebase to keep using the familiar API without having to
// refactor dozens of import statements.

// NOTE: `ScrollableInkTabBar` was historically used without any props in this
// codebase (e.g. `renderTabBar={() => <ScrollableInkTabBar />}`) so forwarding
// the incoming props is usually a no-op but keeps things flexible for edge
// cases.

const ScrollableInkTabBar = ({ animated, ...restProps }) => {
  const mergedAnimated = animated || { inkBar: true, tabPane: true };
  return <TabNavList animated={mergedAnimated} {...restProps} />;
};

export default ScrollableInkTabBar; 