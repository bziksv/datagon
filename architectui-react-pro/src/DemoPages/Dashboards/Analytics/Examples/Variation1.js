import React, { Component, Fragment } from "react";
import {
  Row,
  Col,
  Button,
  CardHeader,
  Container,
  Card,
  CardBody,
  Progress,
  ListGroup,
  ListGroupItem,
  CardFooter,
  Input,
  Dropdown,
  DropdownItem,
  DropdownToggle,
  DropdownMenu,
  UncontrolledButtonDropdown,
} from "reactstrap";

import {
  VerticalTimeline,
  VerticalTimelineElement,
} from '../../../../components/React19Timeline';



import DataTable from 'react-data-table-component';

import avatar1 from "../../../../assets/utils/images/avatars/1.jpg";
import avatar2 from "../../../../assets/utils/images/avatars/2.jpg";

import { IoIosAnalytics } from "react-icons/io";

import CustomScrollbar from "../../../../components/CustomScrollbar";

import Slider from "react-slick";

import { makeData } from "../../../Tables/DataTables/Examples/utils";

import { ResponsiveContainer, AreaChart, Area } from "recharts";

import { Sparklines, SparklinesCurve } from "react-sparklines";

import {
  faAngleUp,
  faAngleDown,
  faCalendarAlt,
  faEllipsisH,
  faCheck,
  faTrashAlt,
} from "@fortawesome/free-solid-svg-icons";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import Select from "react-select";

const options = [
  { value: "1", label: "Today" },
  { value: "2", label: "Last Week" },
  { value: "3", label: "Last 30 Days" },
  { value: "4", label: "Last 3 Months" },
  { value: "5", label: "Last Year" },
];

const data55 = [
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

const data552 = [
  { name: "Page A", uv: 4000, pv: 2400, amt: 2400 },
  { name: "Page B", uv: 3000, pv: 1398, amt: 2210 },
  { name: "Page F", uv: 2390, pv: 3800, amt: 2500 },
  { name: "Page C", uv: 2000, pv: 6800, amt: 2290 },
  { name: "Page F", uv: 1390, pv: 3800, amt: 1500 },
  { name: "Page G", uv: 3490, pv: 4300, amt: 2100 },
  { name: "Page D", uv: 4780, pv: 7908, amt: 2000 },
  { name: "Page E", uv: 2890, pv: 9800, amt: 2181 },
  { name: "Page G", uv: 3490, pv: 4300, amt: 2100 },
  { name: "Page C", uv: 2000, pv: 9800, amt: 2290 },
  { name: "Page D", uv: 2780, pv: 3908, amt: 2000 },
  { name: "Page E", uv: 1890, pv: 4800, amt: 2181 },
];

const data553 = [
  { name: "Page A", uv: 4000, pv: 2400, amt: 2400 },
  { name: "Page B", uv: 3000, pv: 1398, amt: 2210 },
  { name: "Page E", uv: 1890, pv: 4800, amt: 2181 },
  { name: "Page F", uv: 1390, pv: 3800, amt: 1500 },
  { name: "Page C", uv: 2000, pv: 9800, amt: 2290 },
  { name: "Page F", uv: 2390, pv: 3800, amt: 2500 },
  { name: "Page G", uv: 3490, pv: 4300, amt: 2100 },
  { name: "Page C", uv: 2000, pv: 6800, amt: 2290 },
  { name: "Page E", uv: 2890, pv: 9800, amt: 2181 },
  { name: "Page D", uv: 4780, pv: 7908, amt: 2000 },
  { name: "Page D", uv: 2780, pv: 3908, amt: 2000 },
  { name: "Page G", uv: 3490, pv: 4300, amt: 2100 },
];

function boxMullerRandom() {
  let phase = true,
    x1,
    x2,
    w;

  return (function () {
    if (phase) {
      do {
        x1 = 2.0 * Math.random() - 1.0;
        x2 = 2.0 * Math.random() - 1.0;
        w = x1 * x1 + x2 * x2;
      } while (w >= 1.0);

      w = Math.sqrt((-2.0 * Math.log(w)) / w);
      return x1 * w;
    } else {
      return x2 * w;
    }
  })();
}

function randomData(n = 30) {
  return Array.apply(0, Array(n)).map(boxMullerRandom);
}

const sampleData = randomData(10);
const sampleData2 = randomData(15);
const sampleData3 = randomData(8);
const sampleData4 = randomData(12);

export default class AnalyticsDashboard1 extends Component {
  constructor() {
    super();

    this.state = {
      data: makeData(),
      dropdownOpen: false,
    };
    this.toggle = this.toggle.bind(this);
  }

  state = {
    selectedOption: null,
  };

  handleChange = (selectedOption) => {
    this.setState({ selectedOption });
  };

  toggle() {
    this.setState((prevState) => ({
      dropdownOpen: !prevState.dropdownOpen,
    }));
  }

  render() {
    const { selectedOption } = this.state;
    const { data } = this.state;
    const columns = [
      {
        name: "First Name",
        selector: row => row.firstName,
        sortable: true,
      },
      {
        name: "Last Name",
        id: "lastName",
        selector: row => row.lastName,
        sortable: true,
      },
    
      {
        name: "Age",
        selector: row => row.age,
        sortable: true,
      },
      {
        name: "Status",
        selector: row => row.status,
        sortable: true,
      },
    
      {
        name: "Visits",
        selector: row => row.visits,
        sortable: true,
        },
    ];

    const settings = {
      className: "",
      centerMode: false,
      infinite: true,
      slidesToShow: 1,
      speed: 500,
      dots: true,
    };

    return (
      <Fragment>
        <Container fluid>
          <Card className="mb-3">
            <CardHeader className="card-header-tab z-index-6">
              <div className="card-header-title font-size-lg text-capitalize fw-normal">
                <i className="header-icon lnr-charts icon-gradient bg-happy-green"> {" "} </i>
                Portfolio Performance
              </div>
              <div className="btn-actions-pane-right text-capitalize">
                <span className="d-inline-block ms-2" style={{ width: 200 }}>
                  <Select value={selectedOption} onChange={this.handleChange} options={options}/>
                </span>
              </div>
            </CardHeader>
            <Row className="g-0">
              <Col sm="6" md="4" xl="4">
                <div className="card no-shadow rm-border bg-transparent widget-chart text-start">
                  <div className="icon-wrapper rounded-circle">
                    <div className="icon-wrapper-bg opacity-10 bg-warning" />
                    <i className="lnr-laptop-phone text-dark opacity-8" />
                  </div>
                  <div className="widget-chart-content">
                    <div className="widget-subheading">Cash Deposits</div>
                    <div className="widget-numbers">1,7M</div>
                    <div className="widget-description opacity-8 text-focus">
                      <div className="d-inline text-danger pe-1">
                        <FontAwesomeIcon icon={faAngleDown} />
                        <span className="ps-1">54.1%</span>
                      </div>
                      less earnings
                    </div>
                  </div>
                </div>
                <div className="divider m-0 d-md-none d-sm-block" />
              </Col>
              <Col sm="6" md="4" xl="4">
                <div className="card no-shadow rm-border bg-transparent widget-chart text-start">
                  <div className="icon-wrapper rounded-circle">
                    <div className="icon-wrapper-bg opacity-9 bg-danger" />
                    <i className="lnr-graduation-hat text-white" />
                  </div>
                  <div className="widget-chart-content">
                    <div className="widget-subheading">Invested Dividents</div>
                    <div className="widget-numbers">
                      <span>{8.7}</span>
                    </div>
                    <div className="widget-description opacity-8 text-focus">
                      Grow Rate:
                      <span className="text-info ps-1">
                        <FontAwesomeIcon icon={faAngleDown} />
                        <span className="ps-1">14.1%</span>
                      </span>
                    </div>
                  </div>
                </div>
                <div className="divider m-0 d-md-none d-sm-block" />
              </Col>
              <Col sm="12" md="4" xl="4">
                <div className="card no-shadow rm-border bg-transparent widget-chart text-start">
                  <div className="icon-wrapper rounded-circle">
                    <div className="icon-wrapper-bg opacity-9 bg-success" />
                    <i className="lnr-apartment text-white" />
                  </div>
                  <div className="widget-chart-content">
                    <div className="widget-subheading">Capital Gains</div>
                    <div className="widget-numbers text-success">
                      <span>{563}</span>
                    </div>
                    <div className="widget-description text-focus">
                      Increased by
                      <span className="text-warning ps-1">
                        <FontAwesomeIcon icon={faAngleUp} />
                        <span className="ps-1">7.35%</span>
                      </span>
                    </div>
                  </div>
                </div>
              </Col>
            </Row>
            <CardFooter className="text-center d-block p-3">
              <Button color="primary" className="btn-pill btn-shadow btn-wide fsize-1" size="lg">
                <span className="me-2 opacity-7">
                  {/* <Ionicon color="#ffffff" icon="ios-analytics-outline" beat={true}/> */}
                  <IoIosAnalytics color="#ffffff" />
                </span>
                <span className="me-1">View Complete Report</span>
              </Button>
            </CardFooter>
          </Card>
          <Row>
            <Col sm="12" lg="6">
              <Card className="mb-3">
                <CardHeader className="card-header-tab">
                  <div className="card-header-title font-size-lg text-capitalize fw-normal">
                    <i className="header-icon lnr-cloud-download icon-gradient bg-happy-itmeo"> {" "} </i>
                    Technical Support
                  </div>

                  <div className="btn-actions-pane-right text-capitalize actions-icon-btn">
                    <UncontrolledButtonDropdown>
                      <DropdownToggle className="btn-icon btn-icon-only" color="link">
                        <i className="pe-7s-menu btn-icon-wrapper" />
                      </DropdownToggle>
                      <DropdownMenu className="dropdown-menu-right rm-pointers dropdown-menu-shadow dropdown-menu-hover-link">
                        <DropdownItem header>Header</DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-inbox"> </i>
                          <span>Menus</span>
                        </DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-file-empty"> </i>
                          <span>Settings</span>
                        </DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-book"> </i>
                          <span>Actions</span>
                        </DropdownItem>
                        <DropdownItem divider />
                        <div className="p-3 text-end">
                          <Button className="me-2 btn-shadow btn-sm" color="link">
                            View Details
                          </Button>
                          <Button className="me-2 btn-shadow btn-sm" color="primary">
                            Action
                          </Button>
                        </div>
                      </DropdownMenu>
                    </UncontrolledButtonDropdown>
                  </div>
                </CardHeader>
                <CardBody className="p-0">
                  <div className="p-1 slick-slider-sm mx-auto">
                    <Slider {...settings}>
                      <div>
                        <div className="widget-chart widget-chart2 text-start p-0">
                          <div className="widget-chat-wrapper-outer">
                            <div className="widget-chart-content widget-chart-content-lg">
                              <div className="widget-chart-flex">
                                <div className="widget-title opacity-5 text-muted text-uppercase">
                                  New accounts since 2018
                                </div>
                              </div>
                              <div className="widget-numbers">
                                <div className="widget-chart-flex">
                                  <div>
                                    <span className="opacity-10 text-success pe-2">
                                      <FontAwesomeIcon icon={faAngleUp} />
                                    </span>
                                    <span>{78}</span>
                                    <small className="opacity-5 ps-1">%</small>
                                  </div>
                                  <div className="widget-title ms-2 font-size-lg fw-normal text-muted">
                                    <span className="text-success ps-2">
                                      +14
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div className="widget-chart-wrapper he-auto opacity-10 m-0">
                              <ResponsiveContainer width="100%" height={140}>
                                <AreaChart data={data55}
                                  margin={{
                                    top: -15,
                                    right: 0,
                                    left: 0,
                                    bottom: 0,
                                  }}>
                                  <Area type="monotoneX" dataKey="uv" stroke="#3ac47d"
                                    strokeWidth="4" fill="#3ac47d" fillOpacity=".2"/>
                                </AreaChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div>
                        <div className="widget-chart widget-chart2 text-start p-0">
                          <div className="widget-chat-wrapper-outer">
                            <div className="widget-chart-content widget-chart-content-lg">
                              <div className="widget-chart-flex">
                                <div className="widget-title opacity-5 text-muted text-uppercase">
                                  Helpdesk Tickets
                                </div>
                              </div>
                              <div className="widget-numbers">
                                <div className="widget-chart-flex">
                                  <div>
                                    <span className="text-warning">34</span>
                                  </div>
                                  <div className="widget-title ms-2 font-size-lg fw-normal text-dark">
                                    <span className="opacity-5 text-muted ps-2 pe-1">
                                      5%
                                    </span>
                                    increase
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div className="widget-chart-wrapper he-auto opacity-10 m-0">
                              <ResponsiveContainer width="100%" height={140}>
                                <AreaChart data={data552}
                                  margin={{
                                    top: -15,
                                    right: 0,
                                    left: 0,
                                    bottom: 0,
                                  }}>
                                  <Area type="monotoneX" dataKey="uv" stroke="#f7b924"
                                    strokeWidth="4" fill="#f7b924" fillOpacity=".2"/>
                                </AreaChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div>
                        <div className="widget-chart widget-chart2 text-start p-0">
                          <div className="widget-chat-wrapper-outer">
                            <div className="widget-chart-content widget-chart-content-lg">
                              <div className="widget-chart-flex">
                                <div className="widget-title opacity-5 text-muted text-uppercase">
                                  Last Year Total Sales
                                </div>
                              </div>
                              <div className="widget-numbers">
                                <div className="widget-chart-flex">
                                  <div>
                                    <small className="opacity-3 pe-1">$</small>
                                    <span>629</span>
                                    <span className="text-primary ps-3">
                                      <FontAwesomeIcon icon={faAngleDown} />
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div className="widget-chart-wrapper he-auto opacity-10 m-0">
                              <ResponsiveContainer width="100%" height={140}>
                                <AreaChart data={data553}
                                  margin={{
                                    top: -15,
                                    right: 0,
                                    left: 0,
                                    bottom: 0,
                                  }}>
                                  <Area type="monotoneX" dataKey="uv" stroke="#545cd8"
                                    strokeWidth="4" fill="#545cd8" fillOpacity=".2"/>
                                </AreaChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        </div>
                      </div>
                    </Slider>
                  </div>
                  <h6 className="text-muted text-uppercase font-size-md opacity-5 ps-3 pe-3 pb-1 fw-normal">
                    Sales Progress
                  </h6>
                  <ListGroup flush>
                    <ListGroupItem className="p-3 bg-transparent">
                      <div className="widget-content p-0">
                        <div className="widget-content-outer">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">Total Orders</div>
                              <div className="widget-subheading">
                                Last year expenses
                              </div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-success">
                                <small>$</small>
                                1896
                              </div>
                            </div>
                          </div>
                          <div className="widget-progress-wrapper">
                            <Progress className="progress-bar-sm progress-bar-animated-alt" color="primary" value="43"/>
                            <div className="progress-sub-label">
                              <div className="sub-label-left">YoY Growth</div>
                              <div className="sub-label-right">100%</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </ListGroupItem>
                  </ListGroup>
                </CardBody>
              </Card>
            </Col>
            <Col sm="12" lg="6">
              <Card className="card-hover-shadow-2x mb-3">
                <CardHeader className="card-header-tab">
                  <div className="card-header-title font-size-lg text-capitalize fw-normal">
                    <i className="header-icon lnr-lighter icon-gradient bg-amy-crisp"> {" "} </i>
                    Timeline Example
                  </div>
                  <div className="btn-actions-pane-right text-capitalize actions-icon-btn">
                    <UncontrolledButtonDropdown>
                      <DropdownToggle className="btn-icon btn-icon-only" color="link">
                        <i className="pe-7s-menu btn-icon-wrapper" />
                      </DropdownToggle>
                      <DropdownMenu className="dropdown-menu-right rm-pointers dropdown-menu-shadow dropdown-menu-hover-link">
                        <DropdownItem header>Header</DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-inbox"> </i>
                          <span>Menus</span>
                        </DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-file-empty"> </i>
                          <span>Settings</span>
                        </DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-book"> </i>
                          <span>Actions</span>
                        </DropdownItem>
                        <DropdownItem divider />
                        <div className="p-3 text-end">
                          <Button className="me-2 btn-shadow btn-sm" color="link">
                            View Details
                          </Button>
                          <Button className="me-2 btn-shadow btn-sm" color="primary">
                            Action
                          </Button>
                        </div>
                      </DropdownMenu>
                    </UncontrolledButtonDropdown>
                  </div>
                </CardHeader>
                <div className="scroll-area-lg">
                  <CustomScrollbar>
                    <div className="p-4">
                      <VerticalTimeline layout="1-column" className="vertical-time-simple vertical-without-time">
                        <VerticalTimelineElement className="vertical-timeline-item"
                          icon={
                            <i className="badge badge-dot badge-dot-xl bg-success"> {" "} </i>
                          }
                          date="2:30 PM">
                          <h4 className="timeline-title">🚀 Product Launch Completed</h4>
                          <p>
                            Successfully launched the new analytics dashboard v2.0 with all premium features enabled. 
                            Customer feedback has been overwhelmingly positive with a 94% satisfaction rate.
                          </p>
                        </VerticalTimelineElement>
                        <VerticalTimelineElement className="vertical-timeline-item"
                          icon={
                            <i className="badge badge-dot badge-dot-xl bg-warning"> {" "} </i>
                          }
                          date="1:15 PM">
                          <h4 className="timeline-title">📊 Q4 Revenue Target Achieved</h4>
                          <p>
                            <b className="text-success">$2.4M revenue</b> reached - exceeding our Q4 target by 15%. 
                            This marks our strongest quarter since company inception.
                          </p>
                        </VerticalTimelineElement>
                        <VerticalTimelineElement className="vertical-timeline-item"
                          icon={
                            <i className="badge badge-dot badge-dot-xl bg-danger"> {" "} </i>
                          }
                          date="11:45 AM">
                          <h4 className="timeline-title">⚠️ Security Audit Scheduled</h4>
                          <p>
                            Critical security review initiated by the compliance team. 
                            All systems will undergo penetration testing and vulnerability assessment.
                          </p>
                        </VerticalTimelineElement>
                        <VerticalTimelineElement className="vertical-timeline-item"
                          icon={
                            <i className="badge badge-dot badge-dot-xl bg-primary"> {" "} </i>
                          }
                          date="10:00 AM">
                          <h4 className="timeline-title text-primary">👥 New Team Members Onboarded</h4>
                          <p>
                            Welcome to our expanding team! 3 new senior developers and 1 UX designer 
                            have joined the analytics team to accelerate our roadmap delivery.
                          </p>
                        </VerticalTimelineElement>
                        <VerticalTimelineElement className="vertical-timeline-item"
                          icon={
                            <i className="badge badge-dot badge-dot-xl bg-info"> {" "} </i>
                          }
                          date="Yesterday">
                          <h4 className="timeline-title">🔧 Infrastructure Upgrade</h4>
                          <p>
                            Completed migration to cloud infrastructure with 99.9% uptime guarantee. 
                            Application performance improved by <span className="text-success">40%</span> across all metrics.
                          </p>
                        </VerticalTimelineElement>
                        <VerticalTimelineElement className="vertical-timeline-item"
                          icon={
                            <i className="badge badge-dot badge-dot-xl bg-dark"> {" "} </i>
                          }
                          date="2 days ago">
                          <h4 className="timeline-title">📈 Market Analysis Complete</h4>
                          <p>
                            Comprehensive competitive analysis reveals our platform leads in 
                            <b className="text-info">user engagement</b> and <b className="text-info">feature adoption</b> 
                            compared to top 5 competitors.
                          </p>
                        </VerticalTimelineElement>
                        <VerticalTimelineElement className="vertical-timeline-item"
                          icon={
                            <i className="badge badge-dot badge-dot-xl bg-secondary"> {" "} </i>
                          }
                          date="1 week ago">
                          <h4 className="timeline-title text-muted">📋 Quarterly Planning Session</h4>
                          <p>
                            Strategic roadmap for Q1 2024 finalized. Focus areas include AI integration, 
                            mobile optimization, and enterprise security enhancements.
                          </p>
                        </VerticalTimelineElement>
                      </VerticalTimeline>
                    </div>
                  </CustomScrollbar>
                </div>
                <CardFooter className="d-block text-center">
                  <Button className="btn-shadow btn-wide btn-pill" color="focus">
                    <div className="badge badge-dot badge-dot-lg bg-warning badge-pulse">
                      Badge
                    </div>
                    View All Messages
                  </Button>
                </CardFooter>
              </Card>
            </Col>
          </Row>
          <Row>
            <Col md="6" xl="3">
              <div className="card mb-3 widget-chart widget-chart2 text-start card-btm-border card-shadow-success border-success">
                <div className="widget-chat-wrapper-outer">
                  <div className="widget-chart-content pt-3 ps-3 pb-1">
                    <div className="widget-chart-flex">
                      <div className="widget-numbers">
                        <div className="widget-chart-flex">
                          <div className="fsize-4">
                            <small className="opacity-5">$</small>
                            <span>{874}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <h6 className="widget-subheading mb-0 opacity-5">
                      sales last month
                    </h6>
                  </div>
                  <Row className="g-0 widget-chart-wrapper mt-3 mb-3 ps-2 he-auto">
                    <Col md="9">
                      <Sparklines data={sampleData}>
                        <SparklinesCurve
                          style={{
                            strokeWidth: 3,
                            stroke: "#3ac47d",
                            fill: "none",
                          }}/>
                      </Sparklines>
                    </Col>
                  </Row>
                </div>
              </div>
            </Col>
            <Col md="6" xl="3">
              <div className="card mb-3 widget-chart widget-chart2 text-start card-btm-border card-shadow-primary border-primary">
                <div className="widget-chat-wrapper-outer">
                  <div className="widget-chart-content pt-3 ps-3 pb-1">
                    <div className="widget-chart-flex">
                      <div className="widget-numbers">
                        <div className="widget-chart-flex">
                          <div className="fsize-4">
                            <small className="opacity-5">$</small>
                            <span>{1283}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <h6 className="widget-subheading mb-0 opacity-5">
                      sales Income
                    </h6>
                  </div>
                  <Row className="g-0 widget-chart-wrapper mt-3 mb-3 ps-2 he-auto">
                    <Col md="9">
                      <Sparklines data={sampleData2}>
                        <SparklinesCurve
                          style={{
                            strokeWidth: 3,
                            stroke: "#545cd8",
                            fill: "none",
                          }}/>
                      </Sparklines>
                    </Col>
                  </Row>
                </div>
              </div>
            </Col>
            <Col md="6" xl="3">
              <div className="card mb-3 widget-chart widget-chart2 text-start card-btm-border card-shadow-warning border-warning">
                <div className="widget-chat-wrapper-outer">
                  <div className="widget-chart-content pt-3 ps-3 pb-1">
                    <div className="widget-chart-flex">
                      <div className="widget-numbers">
                        <div className="widget-chart-flex">
                          <div className="fsize-4">
                            <small className="opacity-5">$</small>
                            <span>{1286}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <h6 className="widget-subheading mb-0 opacity-5">
                      last month sales
                    </h6>
                  </div>
                  <Row className="g-0 widget-chart-wrapper mt-3 mb-3 ps-2 he-auto">
                    <Col md="9">
                      <Sparklines data={sampleData3}>
                        <SparklinesCurve
                          style={{
                            strokeWidth: 3,
                            stroke: "#f7b924",
                            fill: "none",
                          }}/>
                      </Sparklines>
                    </Col>
                  </Row>
                </div>
              </div>
            </Col>
            <Col md="6" xl="3">
              <div className="card mb-3 widget-chart widget-chart2 text-start card-btm-border card-shadow-danger border-danger">
                <div className="widget-chat-wrapper-outer">
                  <div className="widget-chart-content pt-3 ps-3 pb-1">
                    <div className="widget-chart-flex">
                      <div className="widget-numbers">
                        <div className="widget-chart-flex">
                          <div className="fsize-4">
                            <small className="opacity-5">$</small>
                            <span>{564}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <h6 className="widget-subheading mb-0 opacity-5">
                      total revenue
                    </h6>
                  </div>
                  <Row className="g-0 widget-chart-wrapper mt-3 mb-3 ps-2 he-auto">
                    <Col md="9">
                      <Sparklines data={sampleData4}>
                        <SparklinesCurve
                          style={{
                            strokeWidth: 3,
                            stroke: "#d92550",
                            fill: "none",
                          }} />
                      </Sparklines>
                    </Col>
                  </Row>
                </div>
              </div>
            </Col>
          </Row>
          <Card className="mb-3">
            <CardHeader className="card-header-tab">
              <div className="card-header-title font-size-lg text-capitalize fw-normal">
                <i className="header-icon lnr-laptop-phone me-3 text-muted opacity-6"> {" "} </i>
                Easy Dynamic Tables
              </div>
              <div className="btn-actions-pane-right actions-icon-btn">
                <UncontrolledButtonDropdown>
                  <DropdownToggle className="btn-icon btn-icon-only" color="link">
                    <i className="pe-7s-menu btn-icon-wrapper" />
                  </DropdownToggle>
                  <DropdownMenu className="dropdown-menu-right rm-pointers dropdown-menu-shadow dropdown-menu-hover-link">
                    <DropdownItem header>Header</DropdownItem>
                    <DropdownItem>
                      <i className="dropdown-icon lnr-inbox"> </i>
                      <span>Menus</span>
                    </DropdownItem>
                    <DropdownItem>
                      <i className="dropdown-icon lnr-file-empty"> </i>
                      <span>Settings</span>
                    </DropdownItem>
                    <DropdownItem>
                      <i className="dropdown-icon lnr-book"> </i>
                      <span>Actions</span>
                    </DropdownItem>
                    <DropdownItem divider />
                    <div className="p-3 text-end">
                      <Button className="me-2 btn-shadow btn-sm" color="link">
                        View Details
                      </Button>
                      <Button className="me-2 btn-shadow btn-sm" color="primary">
                        Action
                      </Button>
                    </div>
                  </DropdownMenu>
                </UncontrolledButtonDropdown>
              </div>
            </CardHeader>
            <CardBody>
            <DataTable data={data}
                columns={columns}
                pagination
                fixedHeader
                fixedHeaderScrollHeight="400px"
              />
            </CardBody>
          </Card>
          <Row>
            <Col sm="12" lg="6">
              <Card className="card-hover-shadow-2x mb-3">
                <CardHeader className="card-header-tab">
                  <div className="card-header-title font-size-lg text-capitalize fw-normal">
                    <i className="header-icon lnr-database icon-gradient bg-malibu-beach"> {" "} </i>
                    Tasks List
                  </div>

                  <div className="btn-actions-pane-right text-capitalize actions-icon-btn">
                    <UncontrolledButtonDropdown>
                      <DropdownToggle className="btn-icon btn-icon-only" color="link">
                        <i className="pe-7s-menu btn-icon-wrapper" />
                      </DropdownToggle>
                      <DropdownMenu className="dropdown-menu-right rm-pointers dropdown-menu-shadow dropdown-menu-hover-link">
                        <DropdownItem header>Header</DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-inbox"> </i>
                          <span>Menus</span>
                        </DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-file-empty"> </i>
                          <span>Settings</span>
                        </DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-book"> </i>
                          <span>Actions</span>
                        </DropdownItem>
                        <DropdownItem divider />
                        <div className="p-3 text-end">
                          <Button className="me-2 btn-shadow btn-sm" color="link">
                            View Details
                          </Button>
                          <Button className="me-2 btn-shadow btn-sm" color="primary">
                            Action
                          </Button>
                        </div>
                      </DropdownMenu>
                    </UncontrolledButtonDropdown>
                  </div>
                </CardHeader>
                <div className="scroll-area-lg">
                  <CustomScrollbar>
                    <div className="p-2">
                      <ListGroup className="todo-list-wrapper" flush>
                        <ListGroupItem>
                          <div className="todo-indicator bg-warning" />
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-2 ms-2">
                                <Input type="checkbox" className="me-2 form-check-input-custom" id="exampleCustomCheckbox12" label="&nbsp;"/>
                              </div>
                              <div className="widget-content-left">
                                <div className="widget-heading">
                                  Wash the car
                                  <div className="badge bg-danger ms-2">
                                    Rejected
                                  </div>
                                </div>
                                <div className="widget-subheading">
                                  <i>Written by Bob</i>
                                </div>
                              </div>
                              <div className="widget-content-right widget-content-actions">
                                <Button className="border-0 btn-transition" outline color="success">
                                  <FontAwesomeIcon icon={faCheck} />
                                </Button>
                                <Button className="border-0 btn-transition" outline color="danger">
                                  <FontAwesomeIcon icon={faTrashAlt} />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </ListGroupItem>
                        <ListGroupItem>
                          <div className="todo-indicator bg-focus" />
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-2 ms-2">
                                <Input type="checkbox" className="me-2 form-check-input-custom" id="exampleCustomCheckbox1" label="&nbsp;"/>
                              </div>
                              <div className="widget-content-left">
                                <div className="widget-heading">
                                  Task with hover dropdown menu
                                </div>
                                <div className="widget-subheading">
                                  <div>
                                    By Johnny
                                    <div className="badge rounded-pill bg-info ms-2">
                                      NEW
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className="widget-content-right widget-content-actions">
                                <Dropdown className="d-inline-block rm-pointers" onMouseOver={this.onMouseEnter}
                                  onMouseLeave={this.onMouseLeave} isOpen={this.state.dropdownOpen} toggle={this.toggle}>
                                  <DropdownToggle color="link" className="border-0 btn-transition">
                                    <FontAwesomeIcon icon={faEllipsisH} />
                                  </DropdownToggle>
                                  <DropdownMenu end>
                                    <DropdownItem header>Header</DropdownItem>
                                    <DropdownItem disabled>Action</DropdownItem>
                                  </DropdownMenu>
                                </Dropdown>
                              </div>
                            </div>
                          </div>
                        </ListGroupItem>
                        <ListGroupItem>
                          <div className="todo-indicator bg-primary" />
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-2 ms-2">
                                <Input type="checkbox" className="me-2 form-check-input-custom" id="exampleCustomCheckbox4" label="&nbsp;"/>
                              </div>
                              <div className="widget-content-left flex2">
                                <div className="widget-heading">
                                  Task with Badge
                                </div>
                                <div className="widget-subheading">
                                  Show on hover actions!
                                </div>
                              </div>
                              <div className="widget-content-right widget-content-actions">
                                <Button className="border-0 btn-transition" outline color="success">
                                  <FontAwesomeIcon icon={faCheck} />
                                </Button>
                              </div>
                              <div className="widget-content-right ms-3">
                                <div className="badge rounded-pill bg-success">
                                  New
                                </div>
                              </div>
                            </div>
                          </div>
                        </ListGroupItem>
                        <ListGroupItem>
                          <div className="todo-indicator bg-info" />
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-2 ms-2">
                                <Input type="checkbox" className="me-2 form-check-input-custom" id="exampleCustomCheckbox2" label="&nbsp;"/>
                              </div>
                              <div className="widget-content-left me-3">
                                <div className="widget-content-left">
                                  <img width={42} className="rounded" src={avatar2} alt=""/>
                                </div>
                              </div>
                              <div className="widget-content-left">
                                <div className="widget-heading">
                                  Go grocery shopping
                                </div>
                                <div className="widget-subheading">
                                  A short description here
                                </div>
                              </div>
                              <div className="widget-content-right widget-content-actions">
                                <Button className="border-0 btn-transition" outline color="success">
                                  <FontAwesomeIcon icon={faCheck} />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </ListGroupItem>
                        <ListGroupItem>
                          <div className="todo-indicator bg-success" />
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-2 ms-2">
                                <Input type="checkbox" className="me-2 form-check-input-custom" id="exampleCustomCheckbox3" label="&nbsp;"/>
                              </div>
                              <div className="widget-content-left flex2">
                                <div className="widget-heading">
                                  Development Task
                                </div>
                                <div className="widget-subheading">
                                  Finish React ToDo List App
                                </div>
                              </div>
                              <div className="widget-content-right">
                                <Button className="border-0 btn-transition" outline color="success">
                                  <FontAwesomeIcon icon={faCheck} />
                                </Button>
                                <Button className="border-0 btn-transition" outline color="danger">
                                  <FontAwesomeIcon icon={faTrashAlt} />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </ListGroupItem>
                        <ListGroupItem>
                          <div className="todo-indicator bg-warning" />
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-2 ms-2">
                                <Input type="checkbox" className="me-2 form-check-input-custom" id="exampleCustomCheckbox12" label="&nbsp;"/>
                              </div>
                              <div className="widget-content-left">
                                <div className="widget-heading">
                                  Wash the car
                                  <div className="badge bg-danger ms-2">
                                    Rejected
                                  </div>
                                </div>
                                <div className="widget-subheading">
                                  <i>Written by Bob</i>
                                </div>
                              </div>
                              <div className="widget-content-right widget-content-actions">
                                <Button className="border-0 btn-transition" outline color="success">
                                  <FontAwesomeIcon icon={faCheck} />
                                </Button>
                                <Button className="border-0 btn-transition" outline color="danger">
                                  <FontAwesomeIcon icon={faTrashAlt} />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </ListGroupItem>
                        <ListGroupItem>
                          <div className="todo-indicator bg-focus" />
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-2 ms-2">
                                <Input type="checkbox" className="me-2 form-check-input-custom" id="exampleCustomCheckbox1" label="&nbsp;"/>
                              </div>
                              <div className="widget-content-left">
                                <div className="widget-heading">
                                  Task with hover dropdown menu
                                </div>
                                <div className="widget-subheading">
                                  <div>
                                    By Johnny
                                    <div className="badge rounded-pill badge-info ms-2">
                                      NEW
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className="widget-content-right widget-content-actions">
                                <Dropdown className="d-inline-block rm-pointers" onMouseOver={this.onMouseEnter}
                                  onMouseLeave={this.onMouseLeave} isOpen={this.state.dropdownOpen} toggle={this.toggle}>
                                  <DropdownToggle color="link" className="border-0 btn-transition">
                                    <FontAwesomeIcon icon={faEllipsisH} />
                                  </DropdownToggle>
                                  <DropdownMenu end>
                                    <DropdownItem header>Header</DropdownItem>
                                    <DropdownItem disabled>Action</DropdownItem>
                                  </DropdownMenu>
                                </Dropdown>
                              </div>
                            </div>
                          </div>
                        </ListGroupItem>
                        <ListGroupItem>
                          <div className="todo-indicator bg-primary" />
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-2 ms-2">
                                <Input type="checkbox" className="me-2 form-check-input-custom" id="exampleCustomCheckbox4" label="&nbsp;"/>
                              </div>
                              <div className="widget-content-left flex2">
                                <div className="widget-heading">
                                  Badge on the right task
                                </div>
                                <div className="widget-subheading">
                                  This task has show on hover actions!
                                </div>
                              </div>
                              <div className="widget-content-right widget-content-actions">
                                <Button className="border-0 btn-transition" outline color="success">
                                  <FontAwesomeIcon icon={faCheck} />
                                </Button>
                              </div>
                              <div className="widget-content-right ms-3">
                                <div className="badge rounded-pill badge-dark">
                                  NEW
                                </div>
                              </div>
                            </div>
                          </div>
                        </ListGroupItem>
                        <ListGroupItem>
                          <div className="todo-indicator bg-info" />
                          <div className="widget-content p-0">
                            <div className="widget-content-wrapper">
                              <div className="widget-content-left me-2 ms-2">
                                <Input type="checkbox" className="me-2 form-check-input-custom" id="exampleCustomCheckbox2" label="&nbsp;"/>
                              </div>
                              <div className="widget-content-left me-3">
                                <div className="widget-content-left">
                                  <img width={42} className="rounded" src={avatar2} alt=""/>
                                </div>
                              </div>
                              <div className="widget-content-left">
                                <div className="widget-heading">
                                  Purchase apples
                                </div>
                                <div className="widget-subheading">
                                  Description here...
                                </div>
                              </div>
                              <div className="widget-content-right widget-content-actions">
                                <Button className="border-0 btn-transition" outline color="danger">
                                  <FontAwesomeIcon icon={faTrashAlt} />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </ListGroupItem>
                      </ListGroup>
                    </div>
                  </CustomScrollbar>
                </div>
                <CardFooter className="d-block text-end">
                  <Button size="sm" className="me-2" color="link">
                    Cancel
                  </Button>
                  <Button color="primary">Add Task</Button>
                </CardFooter>
              </Card>
            </Col>
            <Col sm="12" lg="6">
              <Card className="card-hover-shadow-2x mb-3">
                <CardHeader className="card-header-tab">
                  <div className="card-header-title font-size-lg text-capitalize fw-normal">
                    <i className="header-icon lnr-printer icon-gradient bg-ripe-malin"> {" "} </i>
                    Chat Box
                  </div>
                  <div className="btn-actions-pane-right text-capitalize actions-icon-btn">
                    <UncontrolledButtonDropdown>
                      <DropdownToggle className="btn-icon btn-icon-only" color="link">
                        <i className="pe-7s-menu btn-icon-wrapper" />
                      </DropdownToggle>
                      <DropdownMenu className="dropdown-menu-right rm-pointers dropdown-menu-shadow dropdown-menu-hover-link">
                        <DropdownItem header>Header</DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-inbox"> </i>
                          <span>Menus</span>
                        </DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-file-empty"> </i>
                          <span>Settings</span>
                        </DropdownItem>
                        <DropdownItem>
                          <i className="dropdown-icon lnr-book"> </i>
                          <span>Actions</span>
                        </DropdownItem>
                        <DropdownItem divider />
                        <div className="p-3 text-end">
                          <Button className="me-2 btn-shadow btn-sm" color="link">
                            View Details
                          </Button>
                          <Button className="me-2 btn-shadow btn-sm" color="primary">
                            Action
                          </Button>
                        </div>
                      </DropdownMenu>
                    </UncontrolledButtonDropdown>
                  </div>
                </CardHeader>
                <div className="scroll-area-lg">
                  <CustomScrollbar>
                    <div className="p-2">
                      <div className="chat-wrapper p-1">
                        <div className="chat-box-wrapper">
                          <div>
                            <div className="avatar-icon-wrapper me-1">
                              <div className="badge badge-bottom btn-shine bg-success badge-dot badge-dot-lg" />
                              <div className="avatar-icon avatar-icon-lg rounded">
                                <img src={avatar1} alt="" />
                              </div>
                            </div>
                          </div>
                          <div>
                            <div className="chat-box">
                              But I must explain to you how all this mistaken
                              idea of denouncing pleasure and praising pain was
                              born and I will give you a complete account of the
                              system.
                            </div>
                            <small className="opacity-6">
                              <FontAwesomeIcon icon={faCalendarAlt} className="me-1"/>
                              11:01 AM | Yesterday
                            </small>
                          </div>
                        </div>
                        <div className="float-end">
                          <div className="chat-box-wrapper chat-box-wrapper-right">
                            <div>
                              <div className="chat-box">
                                Expound the actual teachings of the great
                                explorer of the truth, the master-builder of
                                human happiness.
                              </div>
                              <small className="opacity-6">
                                <FontAwesomeIcon icon={faCalendarAlt} className="me-1"/>
                                11:01 AM | Yesterday
                              </small>
                            </div>
                            <div>
                              <div className="avatar-icon-wrapper ms-1">
                                <div className="badge badge-bottom btn-shine bg-success badge-dot badge-dot-lg" />
                                <div className="avatar-icon avatar-icon-lg rounded">
                                  <img src={avatar1} alt="" />
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="chat-box-wrapper">
                          <div>
                            <div className="avatar-icon-wrapper me-1">
                              <div className="badge badge-bottom btn-shine bg-success badge-dot badge-dot-lg" />
                              <div className="avatar-icon avatar-icon-lg rounded">
                                <img src={avatar1} alt="" />
                              </div>
                            </div>
                          </div>
                          <div>
                            <div className="chat-box bg-primary text-white">
                              But I must explain to you how all this mistaken
                              idea of denouncing pleasure and praising pain was
                              born and I will give you a complete account of the
                              system.
                            </div>
                            <small className="opacity-8 text-danger">
                              <FontAwesomeIcon icon={faCalendarAlt} className="me-1"/>
                              11:01 AM | Yesterday
                            </small>
                          </div>
                        </div>
                        <div className="float-end">
                          <div className="chat-box-wrapper chat-box-wrapper-right">
                            <div>
                              <div className="chat-box">
                                Denouncing pleasure and praising pain was born
                                and I will give you a complete account.
                              </div>
                              <small className="opacity-6">
                                <FontAwesomeIcon icon={faCalendarAlt} className="me-1"/>
                                11:01 AM | Yesterday
                              </small>
                            </div>
                            <div>
                              <div className="avatar-icon-wrapper ms-1">
                                <div className="badge badge-bottom btn-shine bg-success badge-dot badge-dot-lg" />
                                <div className="avatar-icon avatar-icon-lg rounded">
                                  <img src={avatar2} alt="" />
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="float-end">
                          <div className="chat-box-wrapper chat-box-wrapper-right">
                            <div>
                              <div className="chat-box">
                                The master-builder of human happiness.
                              </div>
                              <small className="opacity-6">
                                <FontAwesomeIcon icon={faCalendarAlt} className="me-1"/>
                                11:01 AM | Yesterday
                              </small>
                            </div>
                            <div>
                              <div className="avatar-icon-wrapper ms-1">
                                <div className="badge badge-bottom btn-shine bg-success badge-dot badge-dot-lg" />
                                <div className="avatar-icon avatar-icon-lg rounded">
                                  <img src={avatar2} alt="" />
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CustomScrollbar>
                </div>
                <CardFooter>
                  <Input bsSize="sm" type="text" placeholder="Write here and hit enter to send..."/>
                </CardFooter>
              </Card>
            </Col>
          </Row>
          <div className="card no-shadow bg-transparent no-border rm-borders mb-3">
            <Card>
              <Row className="g-0">
                <Col md="12" lg="4">
                  <ListGroup flush>
                    <ListGroupItem className="bg-transparent">
                      <div className="widget-content p-0">
                        <div className="widget-content-outer">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">Total Orders</div>
                              <div className="widget-subheading">
                                Last year expenses
                              </div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-success">
                                1896
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </ListGroupItem>
                    <ListGroupItem className="bg-transparent">
                      <div className="widget-content p-0">
                        <div className="widget-content-outer">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">Clients</div>
                              <div className="widget-subheading">
                                Total Clients Profit
                              </div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-primary">
                                $12.6k
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </ListGroupItem>
                  </ListGroup>
                </Col>
                <Col md="12" lg="4">
                  <ListGroup flush>
                    <ListGroupItem className="bg-transparent">
                      <div className="widget-content p-0">
                        <div className="widget-content-outer">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">Followers</div>
                              <div className="widget-subheading">
                                People Interested
                              </div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-danger">
                                45,9%
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </ListGroupItem>
                    <ListGroupItem className="bg-transparent">
                      <div className="widget-content p-0">
                        <div className="widget-content-outer">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">
                                Products Sold
                              </div>
                              <div className="widget-subheading">
                                Total revenue streams
                              </div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-warning">
                                $3M
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </ListGroupItem>
                  </ListGroup>
                </Col>
                <Col md="12" lg="4">
                  <ListGroup flush>
                    <ListGroupItem className="bg-transparent">
                      <div className="widget-content p-0">
                        <div className="widget-content-outer">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">Total Orders</div>
                              <div className="widget-subheading">
                                Last year expenses
                              </div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-success">
                                1896
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </ListGroupItem>
                    <ListGroupItem className="bg-transparent">
                      <div className="widget-content p-0">
                        <div className="widget-content-outer">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">Clients</div>
                              <div className="widget-subheading">
                                Total Clients Profit
                              </div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-primary">
                                $12.6k
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </ListGroupItem>
                  </ListGroup>
                </Col>
              </Row>
            </Card>
          </div>
        </Container>
      </Fragment>
    );
  }
}
