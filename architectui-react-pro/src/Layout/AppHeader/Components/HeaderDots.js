import React, { Fragment } from "react";

import {
  IoIosGrid,
  IoIosAnalytics,
} from "react-icons/io";

import {
  UncontrolledDropdown,
  DropdownToggle,
  DropdownMenu,
  Nav,
  Col,
  Row,
  Button,
  NavItem,
  DropdownItem,
} from "reactstrap";

import { AreaChart, Area, ResponsiveContainer } from "recharts";

import { faArrowLeft, faCog } from "@fortawesome/free-solid-svg-icons";



import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import bg4 from "../../../assets/utils/images/dropdown-header/abstract4.jpg";

const data = [
  { name: "Page A", uv: 4000, pv: 2400, amt: 2400 },
  { name: "Page B", uv: 3000, pv: 1398, amt: 2210 },
  { name: "Page C", uv: 2000, pv: 9800, amt: 2290 },
  { name: "Page D", uv: 2780, pv: 3908, amt: 2000 },
  { name: "Page E", uv: 1890, pv: 4800, amt: 2181 },
  { name: "Page F", uv: 2390, pv: 3800, amt: 2500 },
  { name: "Page G", uv: 3490, pv: 4300, amt: 2100 },
  { name: "Page C", uv: 2000, pv: 6800, amt: 2290 },
  { name: "Page D", uv: 4780, pv: 7908, amt: 2000 },
  { name: "Page E", uv: 2890, pv: 9800, amt: 2181 },
  { name: "Page F", uv: 1390, pv: 3800, amt: 1500 },
  { name: "Page G", uv: 3490, pv: 4300, amt: 2100 },
];

class HeaderDots extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      active: false,
      onlineUsers: null,
      loadingUsers: false,
      usersError: "",
    };
  }

  componentDidMount() {
    this.loadOnlineUsers();
  }

  getAuthHeaders = () => {
    const headers = {};
    const username = window.localStorage.getItem("currentUser");
    const token = window.localStorage.getItem("authToken");
    if (username) headers["x-auth-username"] = username;
    if (token) headers["x-auth-token"] = token;
    return headers;
  };

  loadOnlineUsers = async () => {
    this.setState({ loadingUsers: true, usersError: "" });
    try {
      const res = await fetch("/api/auth/users", { headers: this.getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Недоступно");
      const rows = Array.isArray(json.data) ? json.data : [];
      const onlineUsers = rows.reduce((acc, u) => acc + Number(u.active_sessions || 0), 0);
      this.setState({ onlineUsers, loadingUsers: false, usersError: "" });
    } catch (e) {
      this.setState({ loadingUsers: false, usersError: e.message || "Недоступно" });
    }
  };

  render() {
    return (
      <Fragment>
        <div className="header-dots">
          <UncontrolledDropdown>
            <DropdownToggle className="p-0 me-2" color="link">
              <div className="icon-wrapper icon-wrapper-alt rounded-circle">
                <div className="icon-wrapper-bg bg-primary" />
                <IoIosGrid color="#3f6ad8" fontSize="23px" />
              </div>
            </DropdownToggle>
            <DropdownMenu end className="dropdown-menu-xl rm-pointers">
              <div className="dropdown-menu-header">
                <div className="dropdown-menu-header-inner bg-plum-plate">
                  <div className="menu-header-image"
                    style={{
                      backgroundImage: "url(" + bg4 + ")",
                    }}/>
                  <div className="menu-header-content text-white">
                    <h5 className="menu-header-title">Grid Dashboard</h5>
                    <h6 className="menu-header-subtitle">
                      Easy grid navigation inside dropdowns
                    </h6>
                  </div>
                </div>
              </div>
              <div className="grid-menu grid-menu-xl grid-menu-3col">
                <Row className="g-0s">
                  <Col xl="4" sm="6">
                    <Button className="btn-icon-vertical btn-square btn-transition" outline color="link">
                      <i className="pe-7s-world icon-gradient bg-night-fade btn-icon-wrapper btn-icon-lg mb-3">  {" "} </i>
                      Automation
                    </Button>
                  </Col>
                  <Col xl="4" sm="6">
                    <Button className="btn-icon-vertical btn-square btn-transition" outline color="link">
                      <i className="pe-7s-piggy icon-gradient bg-night-fade btn-icon-wrapper btn-icon-lg mb-3">
                        {" "}
                      </i>
                      Reports
                    </Button>
                  </Col>
                  <Col xl="4" sm="6">
                    <Button className="btn-icon-vertical btn-square btn-transition" outline color="link">
                      <i className="pe-7s-config icon-gradient bg-night-fade btn-icon-wrapper btn-icon-lg mb-3"> {" "} </i>
                      Settings
                    </Button>
                  </Col>
                  <Col xl="4" sm="6">
                    <Button className="btn-icon-vertical btn-square btn-transition" outline color="link">
                      <i className="pe-7s-browser icon-gradient bg-night-fade btn-icon-wrapper btn-icon-lg mb-3"> {" "} </i>
                      Content
                    </Button>
                  </Col>
                  <Col xl="4" sm="6">
                    <Button className="btn-icon-vertical btn-square btn-transition" outline color="link">
                      <i className="pe-7s-hourglass icon-gradient bg-night-fade btn-icon-wrapper btn-icon-lg mb-3"> {" "} </i>
                      Activity
                    </Button>
                  </Col>
                  <Col xl="4" sm="6">
                    <Button className="btn-icon-vertical btn-square btn-transition" outline color="link">
                      <i className="pe-7s-world icon-gradient bg-night-fade btn-icon-wrapper btn-icon-lg mb-3"> {" "} </i>
                      Contacts
                    </Button>
                  </Col>
                </Row>
              </div>
              <Nav vertical>
                <NavItem className="nav-item-divider" />
                <NavItem className="nav-item-btn text-center">
                  <Button size="sm" className="btn-shadow" color="primary">
                    Follow-ups
                  </Button>
                </NavItem>
              </Nav>
            </DropdownMenu>
          </UncontrolledDropdown>
          <UncontrolledDropdown>
            <DropdownToggle className="p-0" color="link">
              <div className="icon-wrapper icon-wrapper-alt rounded-circle">
                <div className="icon-wrapper-bg bg-success" />
                <IoIosAnalytics color="#3ac47d" fontSize="23px" />
              </div>
            </DropdownToggle>
            <DropdownMenu end className="dropdown-menu-xl rm-pointers">
              <div className="dropdown-menu-header">
                <div className="dropdown-menu-header-inner bg-premium-dark">
                  <div className="menu-header-image"
                    style={{
                      backgroundImage: "url(" + bg4 + ")",
                    }}/>
                  <div className="menu-header-content text-white">
                    <h5 className="menu-header-title">Пользователи онлайн</h5>
                    <h6 className="menu-header-subtitle">
                      Актуальная активность сессий
                    </h6>
                  </div>
                </div>
              </div>
              <div className="widget-chart">
                <div className="widget-chart-content">
                  <div className="icon-wrapper rounded-circle">
                    <div className="icon-wrapper-bg opacity-9 bg-focus" />
                    <i className="lnr-users text-white" />
                  </div>
                  <div className="widget-numbers">
                    <span>{this.state.loadingUsers ? "..." : (this.state.onlineUsers ?? "-")}</span>
                  </div>
                  <div className="widget-subheading pt-2">
                    Активных сессий пользователей
                  </div>
                  {this.state.usersError ? (
                    <div className="widget-description text-warning">
                      <span>{this.state.usersError}</span>
                    </div>
                  ) : (
                    <div className="widget-description text-success">
                      <span className="pe-1">Обновлено сейчас</span>
                    </div>
                  )}
                </div>
                <div className="widget-chart-wrapper">
                  <ResponsiveContainer width="100%" minWidth={1} minHeight={40} aspect={3.0 / 1.0}>
                    <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                      <Area type="monotoneX" dataKey="uv" stroke="#f7b924" fill="#f7b924" fillOpacity=".5"/>
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <Nav vertical>
                <NavItem className="nav-item-divider mt-0"> </NavItem>
                <NavItem className="nav-item-btn text-center">
                  <Button size="sm" className="btn-shine btn-wide btn-pill" color="warning" onClick={this.loadOnlineUsers}>
                    <FontAwesomeIcon className="me-2" icon={faCog} fixedWidth={false}/>
                    Обновить
                  </Button>
                </NavItem>
              </Nav>
            </DropdownMenu>
          </UncontrolledDropdown>
        </div>
      </Fragment>
    );
  }
}

export default HeaderDots;
