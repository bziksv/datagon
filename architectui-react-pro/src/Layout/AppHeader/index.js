import React, { Fragment } from "react";
import cx from "classnames";

import { connect } from "react-redux";

import HeaderLogo from "../AppLogo";

import SearchBox from "./Components/SearchBox";
import MegaMenu from "./Components/MegaMenu";
import UserBox from "./Components/UserBox";

import HeaderDots from "./Components/HeaderDots";
import ThemeOptions from "../ThemeOptions";

class Header extends React.Component {
  render() {
    let {
      headerBackgroundColor,
      enableMobileMenuSmall,
      enableHeaderShadow,
    } = this.props;
    return (
      <div
        className={cx("app-header", headerBackgroundColor, {
          "header-shadow": enableHeaderShadow,
        })}
      >
        <HeaderLogo />
        <div className={cx("app-header__content", {
            "header-mobile-open": enableMobileMenuSmall,
          })}>
          <div className="app-header-left">
            <SearchBox />
            <MegaMenu />
          </div>
          <div className="app-header-right">
            <ThemeOptions embeddedInHeader />
            <HeaderDots />
            <UserBox />
          </div>
        </div>
      </div>
    );
  }
}

const mapStateToProps = (state) => ({
  enableHeaderShadow: state.ThemeOptions.enableHeaderShadow,
  closedSmallerSidebar: state.ThemeOptions.closedSmallerSidebar,
  headerBackgroundColor: state.ThemeOptions.headerBackgroundColor,
  enableMobileMenuSmall: state.ThemeOptions.enableMobileMenuSmall,
});

const mapDispatchToProps = (dispatch) => ({});

export default connect(mapStateToProps, mapDispatchToProps)(Header);
