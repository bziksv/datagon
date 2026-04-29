import React, { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { connect } from "react-redux";
import SideMenu from "./SideMenu";
import { setEnableMobileMenu } from "../../reducers/ThemeOptions";
import {
  DatagonNav,
  MainNav,
  ComponentsNav,
  FormsNav,
  WidgetsNav,
  ChartsNav,
} from "./NavItems";

const HTML_SOURCE_STORAGE_KEY = "datagon_html_source_expanded_v3";

const Nav = ({ enableMobileMenu, setEnableMobileMenu }) => {
  const [htmlSourceExpanded, setHtmlSourceExpanded] = useState(false);
  const htmlSourceExpandedRef = useRef(htmlSourceExpanded);

  useEffect(() => {
    try {
      // Keep HTML source block collapsed on every page load.
      window.localStorage.setItem(HTML_SOURCE_STORAGE_KEY, "0");
    } catch (_) {}
  }, []);

  useEffect(() => {
    htmlSourceExpandedRef.current = htmlSourceExpanded;
    try {
      window.localStorage.setItem(HTML_SOURCE_STORAGE_KEY, htmlSourceExpanded ? "1" : "0");
    } catch (_) {}
  }, [htmlSourceExpanded]);

  useEffect(() => {
    const persistState = () => {
      try {
        window.localStorage.setItem(
          HTML_SOURCE_STORAGE_KEY,
          htmlSourceExpandedRef.current ? "1" : "0",
        );
      } catch (_) {}
    };
    window.addEventListener("pagehide", persistState);
    window.addEventListener("beforeunload", persistState);
    return () => {
      window.removeEventListener("pagehide", persistState);
      window.removeEventListener("beforeunload", persistState);
    };
  }, []);

  const toggleMobileSidebar = useCallback(() => {
    setEnableMobileMenu(!enableMobileMenu);
  }, [enableMobileMenu, setEnableMobileMenu]);

  const toggleHtmlSource = useCallback(() => {
    setHtmlSourceExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(HTML_SOURCE_STORAGE_KEY, next ? "1" : "0");
      } catch (_) {}
      return next;
    });
  }, []);

  return (
    <div className="datagon-nav-shell">
      <SideMenu content={DatagonNav} onSelected={toggleMobileSidebar}
        className="vertical-nav-menu" />

      <div className="datagon-html-source-dock">
        <button
          type="button"
          className="app-sidebar__heading datagon-html-source-toggle d-flex align-items-center justify-content-between"
          onClick={toggleHtmlSource}
          aria-expanded={htmlSourceExpanded}
          title="Показать/скрыть раздел Исходник HTML"
          style={{ position: "relative", zIndex: 1200, pointerEvents: "auto", width: "100%" }}
        >
          <span>Исходник HTML</span>
          <i className={`pe-7s-angle-${htmlSourceExpanded ? "up" : "down"}`} />
        </button>

        {htmlSourceExpanded ? (
          <>
            <SideMenu content={MainNav} onSelected={toggleMobileSidebar}
              className="vertical-nav-menu" />

            <SideMenu content={ComponentsNav} onSelected={toggleMobileSidebar}
              className="vertical-nav-menu" />

            <SideMenu content={WidgetsNav} onSelected={toggleMobileSidebar}
              className="vertical-nav-menu" />

            <SideMenu content={FormsNav} onSelected={toggleMobileSidebar}
              className="vertical-nav-menu" />

            <SideMenu content={ChartsNav} onSelected={toggleMobileSidebar}
              className="vertical-nav-menu" />
          </>
        ) : null}
      </div>
    </div>
  );
};

const mapStateToProps = (state) => ({
  enableMobileMenu: state.ThemeOptions.enableMobileMenu,
});

const mapDispatchToProps = (dispatch) => ({
  setEnableMobileMenu: (enable) => dispatch(setEnableMobileMenu(enable)),
});

export default connect(mapStateToProps, mapDispatchToProps)(Nav);
