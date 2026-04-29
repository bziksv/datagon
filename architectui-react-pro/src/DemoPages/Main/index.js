import React, { Fragment, useState, useLayoutEffect } from "react";
import { connect } from "react-redux";
import cx from "classnames";

import AppMain from "../../Layout/AppMain";

// ResizeObserver + window.resize; ref через state, чтобы не было гонки useEffect([]) + ref.current === null
// (Strict Mode / первый кадр) и чтобы cleanup всегда снимал те же listener'ы.
const ResizeDetectorWrapper = ({ children }) => {
  const [width, setWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 0
  );
  const [container, setContainer] = useState(null);

  useLayoutEffect(() => {
    if (!container) return undefined;

    const handleResize = () => setWidth(window.innerWidth);

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries[0]) {
        setWidth(entries[0].contentRect.width);
      }
    });
    resizeObserver.observe(container);
    window.addEventListener("resize", handleResize);

    return () => {
      try {
        resizeObserver.disconnect();
      } catch (_) {}
      try {
        window.removeEventListener("resize", handleResize);
      } catch (_) {}
    };
  }, [container]);

  return <div ref={setContainer}>{children(width)}</div>;
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
