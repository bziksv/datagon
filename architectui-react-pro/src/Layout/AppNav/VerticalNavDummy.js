import React, { Fragment } from "react";
import { Link, useLocation } from "react-router-dom";
import MetisMenu from "@metismenu/react";
import "metismenujs/dist/metismenujs.css";

import { MainNav, ComponentsNav, FormsNav, WidgetsNav, ChartsNav } from "./NavItems";

const NavLink = ({ to, children }) => {
  const location = useLocation();
  const isActive = location.pathname === to;
  return (
    <li className={isActive ? "mm-active" : ""}>
      <Link to={to}>{children}</Link>
    </li>
  );
};

const renderNavItems = (items) => {
  return items.map((item, index) => {
    if (item.content) {
      return (
        <li key={index}>
          <a href="/#" onClick={(e) => e.preventDefault()}>
            <i className={`metismenu-icon ${item.icon}`}></i>
            {item.label}
          </a>
          <ul>{renderNavItems(item.content)}</ul>
        </li>
      );
    }
    return (
      <NavLink key={index} to={item.to}>
        <i className={`metismenu-icon ${item.icon}`}></i>
        {item.label}
      </NavLink>
    );
  });
};

function NavDummy() {
  return (
    <Fragment>
      <h5 className="app-sidebar__heading">Menu</h5>
      <MetisMenu>
        {renderNavItems(MainNav)}
      </MetisMenu>
      <h5 className="app-sidebar__heading">UI Components</h5>
      <MetisMenu>
        {renderNavItems(ComponentsNav)}
      </MetisMenu>
      <h5 className="app-sidebar__heading">Forms</h5>
      <MetisMenu>
        {renderNavItems(FormsNav)}
      </MetisMenu>
      <h5 className="app-sidebar__heading">Widgets</h5>
      <MetisMenu>
        {renderNavItems(WidgetsNav)}
      </MetisMenu>
      <h5 className="app-sidebar__heading">Charts</h5>
      <MetisMenu>
        {renderNavItems(ChartsNav)}
      </MetisMenu>
    </Fragment>
  );
}

export default NavDummy;
