import React, { Fragment } from "react";
import SideMenu from "../../../../../../Layout/AppNav/SideMenu";
import { MainNav } from "./NavItemsDummy";

export default function HorizontalNavWrapper() {
  return (
    <Fragment>
      <SideMenu content={MainNav} className="horizontal-nav-menu" />
    </Fragment>
  );
}
