import React, { Fragment } from "react";


import { IoIosCalendar } from "react-icons/io";

import CustomScrollbar from "../../../components/CustomScrollbar";

import {
  DropdownToggle,
  DropdownMenu,
  Nav,
  Col,
  Row,
  Button,
  NavItem,
  NavLink,
  UncontrolledTooltip,
  UncontrolledButtonDropdown,
} from "reactstrap";

import { toast, Bounce } from "react-toastify";

import { faAngleDown } from "@fortawesome/free-solid-svg-icons";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import 'react-toastify/dist/ReactToastify.css';

import city3 from "../../../assets/utils/images/dropdown-header/city3.jpg";
import avatar1 from "../../../assets/utils/images/avatars/1.jpg";

class UserBox extends React.Component {
  constructor(props) {
    super(props);
    const currentUser = String(window.localStorage.getItem("currentUser") || "").trim();
    const currentUserDisplayName = String(window.localStorage.getItem("currentUserDisplayName") || "").trim();
    const isAdmin = window.localStorage.getItem("isAdmin") === "true" || currentUser === "admin";
    this.state = {
      active: false,
      currentUser: currentUser || "—",
      currentUserDisplayName: currentUserDisplayName || currentUser || "—",
      isAdmin,
    };
  }

  componentDidMount() {
    this.loadCurrentUserProfile();
  }

  getAuthHeaders = () => {
    const headers = {};
    const username = window.localStorage.getItem("currentUser");
    const token = window.localStorage.getItem("authToken");
    if (username) headers["x-auth-username"] = username;
    if (token) headers["x-auth-token"] = token;
    return headers;
  };

  loadCurrentUserProfile = async () => {
    try {
      const res = await fetch("/api/auth/me", { headers: this.getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) return;
      const username = String(json.username || "").trim();
      const fullName = String(json.full_name || "").trim() || username;
      const isAdmin = Boolean(json.isAdmin);
      if (username) window.localStorage.setItem("currentUser", username);
      if (fullName) window.localStorage.setItem("currentUserDisplayName", fullName);
      window.localStorage.setItem("isAdmin", isAdmin ? "true" : "false");
      this.setState({
        currentUser: username || this.state.currentUser,
        currentUserDisplayName: fullName || this.state.currentUserDisplayName,
        isAdmin,
      });
    } catch (_) {}
  };

  notify2 = () =>
    (this.toastId = toast(
      "You don't have any new items in your calendar for today! Go out and play!",
      {
        transition: Bounce,
        closeButton: true,
        autoClose: 5000,
        position: "bottom-center",
        type: "success",
      }
    ));

  render() {
    const { currentUser, currentUserDisplayName, isAdmin } = this.state;
    const userRoleLabel = isAdmin ? "Админ" : "Пользователь";

    return (
      <Fragment>
        <div className="header-btn-lg pe-0">
          <div className="widget-content p-0">
            <div className="widget-content-wrapper">
              <div className="widget-content-left">
                <UncontrolledButtonDropdown>
                  <DropdownToggle color="link" className="p-0">
                    <img width={42} className="rounded-circle" src={avatar1} alt=""/>
                    <FontAwesomeIcon
                      className="ms-2 opacity-8"
                      icon={faAngleDown}
                    />
                  </DropdownToggle>
                  <DropdownMenu end className="rm-pointers dropdown-menu-lg">
                    <div className="dropdown-menu-header">
                      <div className="dropdown-menu-header-inner bg-info">
                        <div className="menu-header-image opacity-2"
                          style={{
                            backgroundImage: "url(" + city3 + ")",
                          }}/>
                        <div className="menu-header-content text-start">
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-3">
                                <img width={42} className="rounded-circle" src={avatar1} alt=""/>
                              </div>
                              <div className="widget-content-left">
                                <div className="widget-heading">
                                  {currentUserDisplayName}
                                </div>
                                <div className="widget-subheading opacity-8">
                                  {userRoleLabel}
                                </div>
                              </div>
                              <div className="widget-content-right me-2">
                                <Button className="btn-pill btn-shadow btn-shine" color="focus">
                                  Logout
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="scroll-area-xs"
                      style={{
                        height: "150px",
                      }}>
                      <CustomScrollbar>
                        <Nav vertical>
                          <NavItem className="nav-item-header">
                            Activity
                          </NavItem>
                          <NavItem>
                            <NavLink href="#">
                              Chat
                              <div className="ms-auto badge rounded-pill bg-info">
                                8
                              </div>
                            </NavLink>
                          </NavItem>
                          <NavItem>
                            <NavLink href="#">Recover Password</NavLink>
                          </NavItem>
                          <NavItem className="nav-item-header">
                            My Account
                          </NavItem>
                          <NavItem>
                            <NavLink href="#">
                              Settings
                              <div className="ms-auto badge bg-success">
                                New
                              </div>
                            </NavLink>
                          </NavItem>
                          <NavItem>
                            <NavLink href="#">
                              Messages
                              <div className="ms-auto badge bg-warning">
                                512
                              </div>
                            </NavLink>
                          </NavItem>
                          <NavItem>
                            <NavLink href="#">Logs</NavLink>
                          </NavItem>
                        </Nav>
                      </CustomScrollbar>
                    </div>
                    <Nav vertical>
                      <NavItem className="nav-item-divider mb-0" />
                    </Nav>
                    <div className="grid-menu grid-menu-2col">
                      <Row className="g-0">
                        <Col sm="6">
                          <Button className="btn-icon-vertical btn-transition btn-transition-alt pt-2 pb-2"
                            outline color="warning">
                            <i className="pe-7s-chat icon-gradient bg-amy-crisp btn-icon-wrapper mb-2"> {" "} </i>
                            Message Inbox
                          </Button>
                        </Col>
                        <Col sm="6">
                          <Button className="btn-icon-vertical btn-transition btn-transition-alt pt-2 pb-2"
                            outline color="danger">
                            <i className="pe-7s-ticket icon-gradient bg-love-kiss btn-icon-wrapper mb-2"> {" "} </i>
                            <b>Support Tickets</b>
                          </Button>
                        </Col>
                      </Row>
                    </div>
                    <Nav vertical>
                      <NavItem className="nav-item-divider" />
                      <NavItem className="nav-item-btn text-center">
                        <Button size="sm" className="btn-wide" color="primary">
                          Open Messages
                        </Button>
                      </NavItem>
                    </Nav>
                  </DropdownMenu>
                </UncontrolledButtonDropdown>
              </div>
              <div className="widget-content-left  ms-3 header-user-info">
                <div className="widget-heading">{currentUserDisplayName}</div>
                <div className="widget-subheading">{userRoleLabel}</div>
              </div>
              <div className="widget-content-right header-user-info ms-3">
                <Button className="btn-shadow p-1" size="sm" onClick={this.notify2} color="info" id="Tooltip-1">
                  <IoIosCalendar color="#ffffff" fontSize="20px" />
                </Button>
                <UncontrolledTooltip placement="bottom" target={"Tooltip-1"}>
                  Click for Toastify Notifications!
                </UncontrolledTooltip>
              </div>
            </div>
          </div>
        </div>
      </Fragment>
    );
  }
}

export default UserBox;
