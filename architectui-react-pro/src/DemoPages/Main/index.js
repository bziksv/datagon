import React, { Fragment, useState, useEffect, useRef } from "react";
import { connect } from "react-redux";
import cx from "classnames";

import AppMain from "../../Layout/AppMain";

// Custom resize detector hook using ResizeObserver
const useResizeDetector = () => {
  const [width, setWidth] = useState(window.innerWidth);
  const ref = useRef(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const resizeObserver = new ResizeObserver(entries => {
      if (entries[0]) {
        setWidth(entries[0].contentRect.width);
      }
    });

    resizeObserver.observe(element);

    // Also listen to window resize as fallback
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return { width, ref };
};

// Create a functional component wrapper for resize detection
const ResizeDetectorWrapper = ({ children }) => {
  const { width, ref } = useResizeDetector();
  return (
    <div ref={ref}>
      {children(width)}
    </div>
  );
};

class Main extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      closedSmallerSidebar: false,
    };
  }

  render() {
    let {
      colorScheme,
      enableFixedHeader,
      enableFixedSidebar,
      enableFixedFooter,
      enableClosedSidebar,
      closedSmallerSidebar,
      enableMobileMenu,
      enablePageTabsAlt,
    } = this.props;

    return (
      <ResizeDetectorWrapper>
        {(width) => (
          <Fragment>
            <div
              className={cx(
                "app-container app-theme-" + colorScheme + " datagon-shell",
                { "fixed-header": enableFixedHeader },
                { "fixed-sidebar": enableFixedSidebar },
                { "fixed-footer": enableFixedFooter },
                { "closed-sidebar": enableClosedSidebar },
                { "closed-sidebar-mobile": closedSmallerSidebar },
                { "sidebar-mobile-open": enableMobileMenu }
              )}>
              <AppMain />
            </div>
          </Fragment>
        )}
      </ResizeDetectorWrapper>
    );
  }
}

const mapStateToProp = (state) => ({
  colorScheme: state.ThemeOptions.colorScheme,
  enableFixedHeader: state.ThemeOptions.enableFixedHeader,
  enableMobileMenu: state.ThemeOptions.enableMobileMenu,
  enableFixedFooter: state.ThemeOptions.enableFixedFooter,
  enableFixedSidebar: state.ThemeOptions.enableFixedSidebar,
  enableClosedSidebar: state.ThemeOptions.enableClosedSidebar,
  enablePageTabsAlt: state.ThemeOptions.enablePageTabsAlt,
});

export default connect(mapStateToProp)(Main);
