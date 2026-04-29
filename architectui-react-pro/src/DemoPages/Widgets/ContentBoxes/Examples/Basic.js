import React, { Component, Fragment } from "react";
import { CSSTransition, TransitionGroup } from "../../../../components/React19Transition";
import {
  TabContent,
  TabPane,
  Row,
  Col,
  Card,
  CardHeader,
  ListGroup,
  ListGroupItem,
  Button,
  UncontrolledButtonDropdown,
  DropdownMenu,
  CardBody,
  Nav,
  NavItem,
  NavLink,
  DropdownToggle,
  ButtonGroup,
  Progress,
  CardTitle,
  DropdownItem,
  Popover,
  PopoverBody,
} from "reactstrap";

import CustomScrollbar from "../../../../components/CustomScrollbar";

import Slider from "react-slick";

import bg1 from "../../../../assets/utils/images/dropdown-header/abstract1.jpg";
import bg3 from "../../../../assets/utils/images/dropdown-header/city1.jpg";

import avatar1 from "../../../../assets/utils/images/avatars/1.jpg";
import avatar2 from "../../../../assets/utils/images/avatars/2.jpg";
import avatar3 from "../../../../assets/utils/images/avatars/3.jpg";

import classnames from "classnames";

import 'chart.js/auto';
import { Doughnut, Radar } from "react-chartjs-2";

import {
  XAxis,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  Tooltip,
} from "recharts";

import {
  faEllipsisH,
  faAngleUp,
  faAngleDown,
  faDotCircle,
  faBars,
} from "@fortawesome/free-solid-svg-icons";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import { Sparklines, SparklinesBars, SparklinesLine } from "react-sparklines";

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

const data3333 = [
  { name: "Page A", uv: 4000, pv: 2400, amt: 2400 },
  { name: "Page B", uv: 3000, pv: 1398, amt: 2210 },
  { name: "Page C", uv: 2000, pv: 9800, amt: 2290 },
  { name: "Page D", uv: 2780, pv: 3908, amt: 2000 },
  { name: "Page E", uv: 1890, pv: 4800, amt: 2181 },
  { name: "Page F", uv: 2390, pv: 3800, amt: 2500 },
  { name: "Page G", uv: 3490, pv: 4300, amt: 2100 },
];

const data4 = {
  labels: [
    "Eating",
    "Drinking",
    "Sleeping",
    "Designing",
    "Coding",
    "Cycling",
    "Running",
  ],
  datasets: [
    {
      label: "My First dataset",
      backgroundColor: "rgba(179,181,198,0.2)",
      borderColor: "rgba(179,181,198,1)",
      pointBackgroundColor: "rgba(179,181,198,1)",
      pointBorderColor: "#fff",
      pointHoverBackgroundColor: "#fff",
      pointHoverBorderColor: "rgba(179,181,198,1)",
      data: [65, 59, 90, 81, 56, 55, 40],
    },
    {
      label: "My Second dataset",
      backgroundColor: "rgba(255,99,132,0.2)",
      borderColor: "rgba(255,99,132,1)",
      pointBackgroundColor: "rgba(255,99,132,1)",
      pointBorderColor: "#fff",
      pointHoverBackgroundColor: "#fff",
      pointHoverBorderColor: "rgba(255,99,132,1)",
      data: [28, 48, 40, 19, 96, 27, 100],
    },
  ],
};

const data = {
  labels: ["Red", "Green", "Yellow"],
  datasets: [
    {
      data: [300, 50, 100],
      backgroundColor: ["#FF6384", "#36A2EB", "#FFCE56"],
      hoverBackgroundColor: ["#FF6384", "#36A2EB", "#FFCE56"],
    },
  ],
};

const data2 = [
  { name: "Jan", Sales: 4000, Downloads: 2400, amt: 2400 },
  { name: "Feb", Sales: 3000, Downloads: 1398, amt: 2210 },
  { name: "Mar", Sales: 2000, Downloads: 5800, amt: 2290 },
  { name: "Apr", Sales: 2780, Downloads: 3908, amt: 2000 },
  { name: "Jun", Sales: 1890, Downloads: 4800, amt: 2181 },
  { name: "Jul", Sales: 2390, Downloads: 3800, amt: 2500 },
  { name: "Aug", Sales: 3490, Downloads: 4543, amt: 1233 },
  { name: "Sep", Sales: 1256, Downloads: 1398, amt: 1234 },
  { name: "Oct", Sales: 2345, Downloads: 4300, amt: 5432 },
  { name: "Nov", Sales: 1258, Downloads: 3908, amt: 2345 },
  { name: "Dec", Sales: 3267, Downloads: 2400, amt: 5431 },
];

const data222 = [
  { name: "Jan", Sales: 4000, Downloads: 2400, amt: 2400 },
  { name: "Feb", Sales: 3000, Downloads: 1398, amt: 2210 },
  { name: "Mar", Sales: 2000, Downloads: 5800, amt: 2290 },
  { name: "Apr", Sales: 2780, Downloads: 3908, amt: 2000 },
  { name: "Jun", Sales: 1890, Downloads: 4800, amt: 2181 },
  { name: "Jul", Sales: 2390, Downloads: 3800, amt: 2500 },
];

function boxMullerRandom() {
  let phase = true,
    x1,
    x2,
    w;

  return (function() {
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

// Memoized chart components to prevent unnecessary re-renders
const MemoizedAreaChart = React.memo(({ data, ...props }) => (
  <ResponsiveContainer width="100%" height={200} minHeight={200}>
    <AreaChart data={data} {...props}>
      <Tooltip />
      <Area type="monotoneX" dataKey="uv" strokeWidth={0} fill="#16aaff"/>
    </AreaChart>
  </ResponsiveContainer>
));

const MemoizedLineChart = React.memo(({ data, ...props }) => (
  <ResponsiveContainer width="100%" height={200} minHeight={200}>
    <LineChart data={data} {...props}>
      <Line type="monotone" dataKey="pv" stroke="#3ac47d" strokeWidth={3}/>
    </LineChart>
  </ResponsiveContainer>
));

const MemoizedBarChart = React.memo(({ data, ...props }) => (
  <ResponsiveContainer width="100%" height={250} minHeight={250}>
    <BarChart data={data} {...props}>
      <XAxis dataKey="name" />
      <Legend />
      <Bar barGap="12" dataKey="Sales" stackId="a" fill="#3f6ad8"/>
      <Bar barGap="12" dataKey="Downloads" stackId="a" fill="#e0f3ff"/>
    </BarChart>
  </ResponsiveContainer>
));

const MemoizedSparklines = React.memo(({ data, limit, height = 90 }) => (
  <Sparklines height={height} data={data} limit={limit}>
    <SparklinesBars style={{ fill: "#41c3f9", fillOpacity: ".25" }}/>
    <SparklinesLine style={{ stroke: "#41c3f9", fill: "none" }}/>
  </Sparklines>
));

// Chart container component to prevent width/height 0 errors
const ChartContainer = React.memo(({ children, height = 200, width = "100%" }) => (
  <div style={{ minHeight: `${height}px`, minWidth: '300px' }}>
    <ResponsiveContainer width={width} height={height}>
      {children}
    </ResponsiveContainer>
  </div>
));

// Stable data that won't change (prevents unnecessary re-renders)
const staticChartData = [
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

class BasicExample extends Component {
  constructor(props) {
    super(props);

    this.toggle = this.toggle.bind(this);
    this.togglePop = this.togglePop.bind(this);
    this.toggleMainTab = this.toggleMainTab.bind(this);

    this.state = {
      activeTab: "1",
      activeTab2: "111",
      mainTab: "static", // New main tab for static vs dynamic charts
      value: 48,
      popoverOpen: false,
      serversData: [],
      performanceData: [],
      analyticsData: [], // Third dynamic chart
    };
  }

  componentDidMount() {
    // Initialize with some initial data for dynamic charts only
        this.setState({
      serversData: [0.5, -0.2, 0.8, -0.3, 0.1, 0.7, -0.4, 0.2, -0.6, 0.9],
      performanceData: [0.3, 0.7, -0.1, 0.4, -0.5, 0.8, 0.2, -0.3, 0.6, -0.4],
      analyticsData: [-0.2, 0.6, 0.1, -0.7, 0.3, -0.1, 0.5, 0.2, -0.4, 0.8]
    });

    // Update only the dynamic sparkline charts (Servers, Performance, and Analytics)
    this.interval = setInterval(() => {
      // Only update if component is mounted AND dynamic tab is active
      if (this.interval && this.state.mainTab === "dynamic") {
        // Update all dynamic chart data
        this.setState(prevState => {
          const newServersData = [...prevState.serversData];
          const newPerformanceData = [...prevState.performanceData];
          const newAnalyticsData = [...prevState.analyticsData];
          
          // Add new points
          newServersData.push(boxMullerRandom());
          newPerformanceData.push(boxMullerRandom());
          newAnalyticsData.push(boxMullerRandom());
          
          // Keep rolling window of 25 points
          if (newServersData.length > 25) {
            newServersData.shift();
          }
          if (newPerformanceData.length > 25) {
            newPerformanceData.shift();
          }
          if (newAnalyticsData.length > 25) {
            newAnalyticsData.shift();
          }
          
          // Only update the specific dynamic data
          return { 
            serversData: newServersData,
            performanceData: newPerformanceData,
            analyticsData: newAnalyticsData
          };
        });
      }
    }, 2000); // Update every 2 seconds for smooth animation
  }

  componentWillUnmount() {
    // Clean up interval to prevent memory leaks
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  toggle(tab) {
    if (this.state.activeTab !== tab) {
      this.setState({
        activeTab: tab,
      });
    }
  }

  toggle2(tab) {
    if (this.state.activeTab2 !== tab) {
      this.setState({
        activeTab2: tab,
      });
    }
  }

  toggleMainTab(tab) {
    if (this.state.mainTab !== tab) {
      this.setState({
        mainTab: tab,
      });
    }
  }

  togglePop() {
    this.setState({
      popoverOpen: !this.state.popoverOpen,
    });
  }

  render() {
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
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={1500} enter={false} exit={false}>
            <div>
              {/* Main Tab Navigation */}
              <Card className="mb-3">
                <CardHeader className="card-header-tab">
                  <div className="card-header-title">
                    <i className="header-icon lnr-layers icon-gradient bg-love-kiss me-3"></i>
                    Chart Modes
                  </div>
                  <div className="btn-actions-pane-right">
                    <ButtonGroup size="sm">
                      <Button 
                        color="primary"
                        className={
                          "btn-shadow " +
                          classnames({
                            active: this.state.mainTab === "static",
                          })
                        }
                        onClick={() => {
                          this.toggleMainTab("static");
                        }}>
                        <i className="fa fa-chart-bar me-2"></i>
                        Static Charts
                      </Button>
                      <Button 
                        color="primary"
                        className={
                          "btn-shadow " +
                          classnames({
                            active: this.state.mainTab === "dynamic",
                          })
                        }
                        onClick={() => {
                          this.toggleMainTab("dynamic");
                        }}>
                        <i className="fa fa-bolt me-2"></i>
                        Live Charts
                      </Button>
                    </ButtonGroup>
                  </div>
                </CardHeader>
              </Card>

              {/* Tab Content */}
              <TabContent activeTab={this.state.mainTab}>
                <TabPane tabId="static">
                  {/* All existing static content goes here */}
              <Row>
                <Col md="12" lg="6">
                  <Card className="mb-3">
                    <CardHeader className="card-header-tab">
                      <div className="card-header-title font-size-lg text-capitalize fw-normal">
                        Backlog Items
                      </div>

                      <div className="btn-actions-pane-right">
                        <ButtonGroup size="sm">
                          <Button caret="true" color="dark"
                            className={
                              "btn-shadow " +
                              classnames({
                                active: this.state.activeTab2 === "222",
                              })
                            }
                            onClick={() => {
                              this.toggle2("222");
                            }}>
                            Last Month
                          </Button>
                          <Button color="dark"
                            className={
                              "btn-shadow " +
                              classnames({
                                active: this.state.activeTab2 === "111",
                              })
                            }
                            onClick={() => {
                              this.toggle2("111");
                            }}>
                            Current Month
                          </Button>
                        </ButtonGroup>
                      </div>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab2}>
                        <TabPane tabId="222">
                          <div className="card mb-3 widget-chart widget-chart2 text-start p-0">
                            <div className="widget-chat-wrapper-outer">
                              <div className="widget-chart-content pt-3 pe-3 ps-3">
                                <div className="widget-chart-flex">
                                  <div className="widget-numbers">
                                    <div className="widget-chart-flex">
                                      <div>
                                        <small className="opacity-5">$</small>
                                            <span>{368}</span>
                                      </div>
                                      <div className="widget-title ms-2 opacity-5 font-size-lg text-muted">
                                        Total Leads
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className="widget-chart-wrapper widget-chart-wrapper-lg opacity-10 m-0">
                                    <ResponsiveContainer width="100%" height={130}>
                                      <MemoizedAreaChart data={data55}
                                    margin={{
                                      top: -10,
                                      right: 0,
                                      left: 0,
                                      bottom: 0,
                                        }} />
                                </ResponsiveContainer>
                              </div>
                            </div>
                          </div>
                          <h6 className="text-muted text-uppercase font-size-md opacity-5 fw-normal">
                            Top Authors
                          </h6>
                          <ListGroup className="rm-list-borders" flush>
                            <ListGroupItem>
                              <div className="widget-content p-0">
                                <div className="widget-content-wrapper">
                                  <div className="widget-content-left me-3">
                                    <img width={42} className="rounded-circle" src={avatar1} alt=""/>
                                  </div>
                                  <div className="widget-content-left">
                                    <div className="widget-heading">
                                      Ella-Rose Henry
                                    </div>
                                    <div className="widget-subheading">
                                      Web Developer
                                    </div>
                                  </div>
                                  <div className="widget-content-right">
                                    <div className="font-size-xlg text-muted">
                                      <small className="opacity-5 pe-1">$</small>
                                          <span>{129}</span>
                                      <small className="text-danger ps-2">
                                        <FontAwesomeIcon icon={faAngleDown} />
                                      </small>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </ListGroupItem>
                            <ListGroupItem>
                              <div className="widget-content p-0">
                                <div className="widget-content-wrapper">
                                  <div className="widget-content-left me-3">
                                    <img width={42} className="rounded-circle" src={avatar2} alt=""/>
                                  </div>
                                  <div className="widget-content-left">
                                    <div className="widget-heading">
                                      Ruben Tillman
                                    </div>
                                    <div className="widget-subheading">
                                      UI Designer
                                    </div>
                                  </div>
                                  <div className="widget-content-right">
                                    <div className="font-size-xlg text-muted">
                                      <small className="opacity-5 pe-1">$</small>
                                          <span>{54}</span>
                                      <small className="text-success ps-2">
                                        <FontAwesomeIcon icon={faAngleUp} />
                                      </small>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </ListGroupItem>
                            <ListGroupItem>
                              <div className="widget-content p-0">
                                <div className="widget-content-wrapper">
                                  <div className="widget-content-left me-3">
                                    <img width={42} className="rounded-circle" src={avatar3} alt=""/>
                                  </div>
                                  <div className="widget-content-left">
                                    <div className="widget-heading">
                                      Vinnie Wagstaff
                                    </div>
                                    <div className="widget-subheading">
                                      Java Programmer
                                    </div>
                                  </div>
                                  <div className="widget-content-right">
                                    <div className="font-size-xlg text-muted">
                                      <small className="opacity-5 pe-1">$</small>
                                          <span>{431}</span>
                                      <small className="text-warning ps-2">
                                        <FontAwesomeIcon icon={faDotCircle} />
                                      </small>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </ListGroupItem>
                          </ListGroup>
                        </TabPane>
                        <TabPane tabId="111">
                          <div className="card mb-3 widget-chart widget-chart2 text-start p-0">
                            <div className="widget-chat-wrapper-outer">
                              <div className="widget-chart-content pt-3 pe-3 ps-3">
                                <div className="widget-chart-flex">
                                  <div className="widget-numbers">
                                    <div className="widget-chart-flex">
                                      <div>
                                        <small className="opacity-5">$</small>
                                            <span>{851}</span>
                                      </div>
                                      <div className="widget-title ms-2 opacity-5 font-size-lg text-muted">
                                        Sales
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className="widget-chart-wrapper widget-chart-wrapper-lg opacity-10 m-0">
                                    <ResponsiveContainer width="100%" height={130}>
                                  <LineChart data={data55}
                                    margin={{
                                      top: 5,
                                      right: 10,
                                      left: 10,
                                      bottom: 0,
                                    }}>
                                    <Line type="monotone" dataKey="pv" stroke="#3ac47d" strokeWidth={3}/>
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          </div>
                          <h6 className="text-muted text-uppercase font-size-md opacity-5 fw-normal">
                            Highlights
                          </h6>
                          <div className="scroll-area-sm">
                                <CustomScrollbar>
                              <ListGroup className="rm-list-borders rm-list-borders-scroll" flush>
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-outer">
                                      <div className="widget-content-wrapper">
                                        <div className="widget-content-left">
                                          <div className="widget-heading">
                                            Total Orders
                                          </div>
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
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-outer">
                                      <div className="widget-content-wrapper">
                                        <div className="widget-content-left">
                                          <div className="widget-heading">
                                            Clients
                                          </div>
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
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-outer">
                                      <div className="widget-content-wrapper">
                                        <div className="widget-content-left">
                                          <div className="widget-heading">
                                            Followers
                                          </div>
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
                                <ListGroupItem>
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
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-outer">
                                      <div className="widget-content-wrapper">
                                        <div className="widget-content-left">
                                          <div className="widget-heading">
                                            Total Expenses
                                          </div>
                                          <div className="widget-subheading">
                                            What has been spent in total
                                          </div>
                                        </div>
                                        <div className="widget-content-right">
                                          <div className="widget-numbers text-muted">
                                            $234k
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </ListGroupItem>
                              </ListGroup>
                                </CustomScrollbar>
                          </div>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                  </Card>
                </Col>
                <Col md="12" lg="6">
                  <Card className="mb-3">
                    <CardHeader className="card-header-tab">
                      <div className="card-header-title font-size-lg text-capitalize fw-normal">
                        <i className="header-icon lnr-music-note me-3 text-muted opacity-6"> {" "} </i>
                        Technical Support
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
                                        <small className="opacity-5 ps-1">
                                          %
                                        </small>
                                      </div>
                                      <div className="widget-title ms-2 font-size-lg fw-normal text-muted">
                                        <span className="text-success ps-2">
                                          +14
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <div className="widget-chart-wrapper widget-chart-wrapper-lg opacity-10 m-0">
                                      <ResponsiveContainer width="100%" height={130}>
                                    <AreaChart data={data55}
                                      margin={{
                                        top: -15,
                                        right: 0,
                                        left: 0,
                                        bottom: 0,
                                      }}>
                                      <Area type="monotoneX" dataKey="uv" stroke="#e570b9" strokeWidth="4" fill="#f5d7ea"/>
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
                                        <span className="text-warning">
                                              <span>{34}</span>
                                        </span>
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
                                <div className="widget-chart-wrapper widget-chart-wrapper-lg opacity-10 m-0">
                                      <ResponsiveContainer width="100%" height={130}>
                                    <AreaChart data={data55}
                                      margin={{
                                        top: -15,
                                        right: 0,
                                        left: 0,
                                        bottom: 0,
                                      }}>
                                      <Area type="monotoneX" dataKey="uv" stroke="#9ce570" strokeWidth="4" fill="#ddf5d7"/>
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
                                        <small className="opacity-5 pe-1">
                                          $
                                        </small>
                                        <span className="text-success">
                                              <span>{629}</span>
                                        </span>
                                        <span className="opacity-5 ps-3">
                                          <FontAwesomeIcon icon={faAngleDown} />
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <div className="widget-chart-wrapper widget-chart-wrapper-lg opacity-10 m-0">
                                      <ResponsiveContainer width="100%" height={130}>
                                    <AreaChart data={data55}
                                      margin={{
                                        top: -15,
                                        right: 0,
                                        left: 0,
                                        bottom: 0,
                                      }}>
                                      <Area type="monotoneX" dataKey="uv" stroke="#1e4bf2" strokeWidth="4" fill="#ccddf9"/>
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
                        <ListGroupItem className="p-3">
                          <div className="widget-content p-0">
                            <div className="widget-content-outer">
                              <div className="widget-content-wrapper">
                                <div className="widget-content-left">
                                  <div className="widget-heading">
                                    Total Orders
                                  </div>
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
                        <ListGroupItem className="p-3">
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
                              <div className="widget-progress-wrapper">
                                <Progress className="progress-bar-sm progress-bar-animated-alt" color="danger" value="77"/>
                                <div className="progress-sub-label">
                                  <div className="sub-label-left">Sales</div>
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
              </Row>
              <div className="divider mt-0" style={{ marginBottom: "30px" }} />
              <Row>
                <Col md="12" lg="6">
                  <Card className="mb-3">
                    <CardHeader className="h-auto p-3">
                      <div>
                        <h5 className="menu-header-title text-capitalize">
                          Sales
                        </h5>
                        <h6 className="menu-header-subtitle text-capitalize opacity-8">
                          Total sales for this year
                        </h6>
                      </div>
                      <div className="btn-actions-pane-right">
                        <UncontrolledButtonDropdown>
                          <DropdownToggle caret size="sm" className="btn-icon btn-icon-only" color="dark">
                            <div className="btn-icon-wrapper">
                              <FontAwesomeIcon icon={faBars} />
                            </div>
                          </DropdownToggle>
                          <DropdownMenu className="dropdown-menu-shadow dropdown-menu-hover-link">
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
                      <Row>
                        <Col md="4">
                          <div className="widget-chart d-flex align-self-center he-100 p-0">
                            <div className="widget-chart-content mx-auto center-elem">
                              <div className="widget-numbers text-success fsize-4">
                                <div>
                                  <span className="opacity-10 text-success pe-2">
                                    <FontAwesomeIcon icon={faAngleUp} />
                                  </span>
                                      <span>{78}</span>
                                  <small className="opacity-5 ps-1">%</small>
                                </div>
                              </div>
                            </div>
                          </div>
                        </Col>
                        <Col md="8">
                          <div className="widget-chart-wrapper chart-wrapper-relative">
                                <ResponsiveContainer width="100%" height={250}>
                              <AreaChart data={data3333} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                                <defs>
                                  <linearGradient id="colorUv" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#f5d7ea" stopOpacity={0}/>
                                    <stop offset="95%" stopColor="#f5d7ea" stopOpacity={0.8}/>
                                  </linearGradient>
                                </defs>
                                <Tooltip />
                                <Area type="monotone" dataKey="uv" stroke="#e570b9" strokeWidth="4" fillOpacity={1} fill="url(#colorUv)"/>
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>
                        </Col>
                      </Row>
                    </CardBody>
                  </Card>
                  <Card className="mb-3">
                    <CardHeader className="h-auto p-3">
                      <div>
                        <h5 className="menu-header-title text-capitalize">
                          Servers
                        </h5>
                        <h6 className="menu-header-subtitle text-capitalize opacity-8">
                          Live servers statistics
                        </h6>
                      </div>
                      <div className="btn-actions-pane-right">
                        <Button size="sm" onClick={this.togglePop} id="PopoverEx1" className="btn-icon btn-icon-only" color="dark">
                          <div className="btn-icon-wrapper">
                            <FontAwesomeIcon icon={faBars} />
                          </div>
                        </Button>
                        <Popover className="popover-custom" placement="bottom-start" isOpen={this.state.popoverOpen}
                          target="PopoverEx1" toggle={this.togglePop}>
                          <PopoverBody>
                            <div className="dropdown-menu-header">
                              <div className="dropdown-menu-header-inner bg-primary">
                                <div className="menu-header-image"
                                  style={{
                                    backgroundImage: "url(" + bg1 + ")",
                                  }}/>
                                <div className="menu-header-content">
                                  <h5 className="menu-header-title">Settings</h5>
                                  <h6 className="menu-header-subtitle">
                                    Manage all of your options
                                  </h6>
                                </div>
                              </div>
                            </div>
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
                              <NavItem className="nav-item-divider" />
                              <NavItem className="nav-item-btn">
                                <Button size="sm" className="btn-wide btn-shadow" color="danger">
                                  Cancel
                                </Button>
                              </NavItem>
                            </Nav>
                          </PopoverBody>
                        </Popover>
                      </div>
                    </CardHeader>
                    <CardBody>
                      <Row>
                        <Col md="4">
                          <div className="widget-chart d-flex align-self-center he-100 p-0">
                            <div className="widget-chart-content mx-auto center-elem">
                              <div className="widget-numbers text-danger fsize-4">
                                <small className="text-muted opacity-5 pe-1">
                                  $
                                </small>
                                2.2M
                              </div>
                            </div>
                          </div>
                        </Col>
                        <Col md="8">
                          <div className="chart-wrapper">
                                <ResponsiveContainer width="100%" height={250}>
                                  <Sparklines height={90} data={this.state.serversData} limit={25}>
                                <SparklinesBars style={{ fill: "#41c3f9", fillOpacity: ".25" }}/>
                                <SparklinesLine style={{ stroke: "#41c3f9", fill: "none" }}/>
                              </Sparklines>
                            </ResponsiveContainer>
                          </div>
                        </Col>
                      </Row>
                    </CardBody>
                  </Card>
                  <Card className="mb-3">
                    <div className="text-center mx-auto mt-3">
                      <div>
                        <ButtonGroup size="sm">
                          <Button caret="true" color="primary"
                            className={
                              "btn-shadow ps-3 pe-3 " +
                              classnames({ active: this.state.activeTab === "1" })
                            }
                            onClick={() => {
                              this.toggle("1");
                            }}>
                            Income
                          </Button>
                          <Button color="primary"
                            className={
                              "btn-shadow pe-3 ps-3 " +
                              classnames({ active: this.state.activeTab === "2" })
                            }
                            onClick={() => {
                              this.toggle("2");
                            }}>
                            Expenses
                          </Button>
                        </ButtonGroup>
                      </div>
                    </div>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab}>
                        <TabPane tabId="1">
                          <div className="text-center">
                            <h5 className="menu-header-title">Target Sales</h5>
                            <h6 className="menu-header-subtitle opacity-6">
                              Total performance for this month
                            </h6>
                          </div>
                              <ResponsiveContainer width="100%" height={210}>
                            <BarChart data={data2}>
                              <XAxis dataKey="name" />
                              <Legend />
                              <Bar barGap="12" dataKey="Sales" stackId="a" fill="#3f6ad8"/>
                              <Bar barGap="12" dataKey="Downloads" stackId="a" fill="#e0f3ff"/>
                            </BarChart>
                          </ResponsiveContainer>
                        </TabPane>
                        <TabPane tabId="2">
                          <div className="text-center">
                            <h5 className="menu-header-title">Tabbed Content</h5>
                            <h6 className="menu-header-subtitle opacity-6">
                              Example of various options built with ArchitectUI
                            </h6>
                          </div>
                          <Card className="card-hover-shadow-2x widget-chart widget-chart2 bg-premium-dark text-start mt-3">
                            <div className="widget-chart-content text-white">
                              <div className="widget-chart-flex">
                                <div className="widget-title">Sales</div>
                                <div className="widget-subtitle opacity-7">
                                  Monthly Goals
                                </div>
                              </div>
                              <div className="widget-chart-flex">
                                <div className="widget-numbers text-success">
                                  <small>$</small>
                                      <span>{976}</span>
                                  <small className="opacity-8 ps-2">
                                    <FontAwesomeIcon icon={faAngleUp} />
                                  </small>
                                </div>
                                <div className="widget-description ms-auto opacity-7">
                                  <FontAwesomeIcon icon={faAngleUp} />
                                  <span>175%</span>
                                </div>
                              </div>
                            </div>
                          </Card>
                          <div className="text-center pt-3">
                            <Button color="success" className="btn-pill btn-shadow btn-wide fsize-1" size="lg">
                              <span>View Complete Report</span>
                            </Button>
                          </div>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                  </Card>
                </Col>
                <Col md="12" lg="6">

                  <Card className="mb-3">
                    <CardHeader className="card-header-tab">
                      <div className="card-header-title">
                        <i className="header-icon lnr-bicycle icon-gradient bg-love-kiss"> {" "} </i>
                        Sales Report
                      </div>
                      <Nav>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab2 === "222",
                            })}
                            onClick={() => {
                              this.toggle2("222");
                            }}>
                            Last Month
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab2 === "111",
                            })}
                            onClick={() => {
                              this.toggle2("111");
                            }}>
                            Current Month
                          </NavLink>
                        </NavItem>
                      </Nav>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab2}>
                        <TabPane tabId="111">
                          <div className="card mb-3 widget-chart widget-chart2 text-start p-0">
                            <div className="widget-chat-wrapper-outer">
                              <div className="widget-chart-content pt-3 pe-3 ps-3">
                                <div className="widget-chart-flex">
                                  <div className="widget-numbers">
                                    <div className="widget-chart-flex">
                                      <div>
                                        <small className="opacity-5">$</small>
                                            <span>{368}</span>
                                      </div>
                                      <div className="widget-title ms-2 opacity-5 font-size-lg text-muted">
                                        Total Leads
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                                  <div className="widget-chart-wrapper widget-chart-wrapper-lg opacity-10 m-0" style={{ minHeight: '200px' }}>
                                    <ResponsiveContainer width="100%" height={200}>
                                  <AreaChart data={data55}
                                    margin={{
                                      top: -10,
                                      right: 0,
                                      left: 0,
                                      bottom: 0,
                                    }}>
                                    <Tooltip />
                                    <Area type="monotoneX" dataKey="uv" strokeWidth={0} fill="#16aaff"/>
                                  </AreaChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          </div>
                          <h6 className="text-muted text-uppercase font-size-md opacity-5 fw-normal">
                            Top Authors
                          </h6>
                          <ListGroup className="rm-list-borders" flush>
                            <ListGroupItem>
                              <div className="widget-content p-0">
                                <div className="widget-content-wrapper">
                                  <div className="widget-content-left me-3">
                                    <img width={42} className="rounded-circle" src={avatar1} alt=""/>
                                  </div>
                                  <div className="widget-content-left">
                                    <div className="widget-heading">
                                      Ella-Rose Henry
                                    </div>
                                    <div className="widget-subheading">
                                      Web Developer
                                    </div>
                                  </div>
                                  <div className="widget-content-right">
                                    <div className="font-size-xlg text-muted">
                                      <small className="opacity-5 pe-1">$</small>
                                          <span>{129}</span>
                                      <small className="text-danger ps-2">
                                        <FontAwesomeIcon icon={faAngleDown} />
                                      </small>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </ListGroupItem>
                            <ListGroupItem>
                              <div className="widget-content p-0">
                                <div className="widget-content-wrapper">
                                  <div className="widget-content-left me-3">
                                    <img width={42} className="rounded-circle" src={avatar2} alt=""/>
                                  </div>
                                  <div className="widget-content-left">
                                    <div className="widget-heading">
                                      Ruben Tillman
                                    </div>
                                    <div className="widget-subheading">
                                      UI Designer
                                    </div>
                                  </div>
                                  <div className="widget-content-right">
                                    <div className="font-size-xlg text-muted">
                                      <small className="opacity-5 pe-1">$</small>
                                          <span>{54}</span>
                                      <small className="text-success ps-2">
                                        <FontAwesomeIcon icon={faAngleUp} />
                                      </small>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </ListGroupItem>
                            <ListGroupItem>
                              <div className="widget-content p-0">
                                <div className="widget-content-wrapper">
                                  <div className="widget-content-left me-3">
                                    <img width={42} className="rounded-circle" src={avatar3} alt=""/>
                                  </div>
                                  <div className="widget-content-left">
                                    <div className="widget-heading">
                                      Vinnie Wagstaff
                                    </div>
                                    <div className="widget-subheading">
                                      Java Programmer
                                    </div>
                                  </div>
                                  <div className="widget-content-right">
                                    <div className="font-size-xlg text-muted">
                                      <small className="opacity-5 pe-1">$</small>
                                          <span>{431}</span>
                                      <small className="text-warning ps-2">
                                        <FontAwesomeIcon icon={faDotCircle} />
                                      </small>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </ListGroupItem>
                          </ListGroup>
                        </TabPane>
                        <TabPane tabId="222">
                          <div className="card mb-3 widget-chart widget-chart2 text-start p-0">
                            <div className="widget-chat-wrapper-outer">
                              <div className="widget-chart-content pt-3 pe-3 ps-3">
                                <div className="widget-chart-flex">
                                  <div className="widget-numbers">
                                    <div className="widget-chart-flex">
                                      <div>
                                        <small className="opacity-5">$</small>
                                            <span>{851}</span>
                                      </div>
                                      <div className="widget-title ms-2 opacity-5 font-size-lg text-muted">
                                        Sales
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className="widget-chart-wrapper widget-chart-wrapper-lg opacity-10 m-0">
                                    <ResponsiveContainer width="100%" height={130}>
                                  <LineChart data={data55}
                                    margin={{
                                      top: 5,
                                      right: 10,
                                      left: 10,
                                      bottom: 0,
                                    }}>
                                    <Line type="monotone" dataKey="pv" stroke="#3ac47d" strokeWidth={3}/>
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          </div>
                          <h6 className="text-muted text-uppercase font-size-md opacity-5 fw-normal">
                            Last Month Highlights
                          </h6>
                          <div className="scroll-area-sm">
                                <CustomScrollbar>
                              <ListGroup className="rm-list-borders rm-list-borders-scroll" flush>
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-wrapper">
                                      <div className="widget-content-left me-3">
                                        <img width={42} className="rounded-circle" src={avatar1} alt=""/>
                                      </div>
                                      <div className="widget-content-left">
                                        <div className="widget-heading">
                                          Ella-Rose Henry
                                        </div>
                                        <div className="widget-subheading">
                                          Web Developer
                                        </div>
                                      </div>
                                      <div className="widget-content-right">
                                        <div className="font-size-xlg text-muted">
                                          <small className="opacity-5 pe-1">
                                            $
                                          </small>
                                              <span>{129}</span>
                                          <small className="text-danger ps-2">
                                            <FontAwesomeIcon icon={faAngleDown} />
                                          </small>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </ListGroupItem>
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-wrapper">
                                      <div className="widget-content-left me-3">
                                        <img width={42} className="rounded-circle" src={avatar2} alt=""/>
                                      </div>
                                      <div className="widget-content-left">
                                        <div className="widget-heading">
                                          Ruben Tillman
                                        </div>
                                        <div className="widget-subheading">
                                          UI Designer
                                        </div>
                                      </div>
                                      <div className="widget-content-right">
                                        <div className="font-size-xlg text-muted">
                                          <small className="opacity-5 pe-1">
                                            $
                                          </small>
                                              <span>{54}</span>
                                          <small className="text-success ps-2">
                                            <FontAwesomeIcon icon={faAngleUp} />
                                          </small>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </ListGroupItem>
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-wrapper">
                                      <div className="widget-content-left me-3">
                                        <img width={42} className="rounded-circle" src={avatar3} alt=""/>
                                      </div>
                                      <div className="widget-content-left">
                                        <div className="widget-heading">
                                          Vinnie Wagstaff
                                        </div>
                                        <div className="widget-subheading">
                                          Java Programmer
                                        </div>
                                      </div>
                                      <div className="widget-content-right">
                                        <div className="font-size-xlg text-muted">
                                          <small className="opacity-5 pe-1">
                                            $
                                          </small>
                                              <span>{431}</span>
                                          <small className="text-warning ps-2">
                                            <FontAwesomeIcon icon={faDotCircle} />
                                          </small>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </ListGroupItem>
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-wrapper">
                                      <div className="widget-content-left me-3">
                                        <img width={42} className="rounded-circle" src={avatar1} alt=""/>
                                      </div>
                                      <div className="widget-content-left">
                                        <div className="widget-heading">
                                          Ella-Rose Henry
                                        </div>
                                        <div className="widget-subheading">
                                          Web Developer
                                        </div>
                                      </div>
                                      <div className="widget-content-right">
                                        <div className="font-size-xlg text-muted">
                                          <small className="opacity-5 pe-1">
                                            $
                                          </small>
                                              <span>{129}</span>
                                          <small className="text-danger ps-2">
                                            <FontAwesomeIcon icon={faAngleDown} />
                                          </small>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </ListGroupItem>
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-wrapper">
                                      <div className="widget-content-left me-3">
                                        <img width={42} className="rounded-circle" src={avatar2} alt=""/>
                                      </div>
                                      <div className="widget-content-left">
                                        <div className="widget-heading">
                                          Ruben Tillman
                                        </div>
                                        <div className="widget-subheading">
                                          UI Designer
                                        </div>
                                      </div>
                                      <div className="widget-content-right">
                                        <div className="font-size-xlg text-muted">
                                          <small className="opacity-5 pe-1">
                                            $
                                          </small>
                                              <span>{54}</span>
                                          <small className="text-success ps-2">
                                            <FontAwesomeIcon icon={faAngleUp} />
                                          </small>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </ListGroupItem>
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-wrapper">
                                      <div className="widget-content-left me-3">
                                        <img width={42} className="rounded-circle" src={avatar1} alt=""/>
                                      </div>
                                      <div className="widget-content-left">
                                        <div className="widget-heading">
                                          Ella-Rose Henry
                                        </div>
                                        <div className="widget-subheading">
                                          Web Developer
                                        </div>
                                      </div>
                                      <div className="widget-content-right">
                                        <div className="font-size-xlg text-muted">
                                          <small className="opacity-5 pe-1">
                                            $
                                          </small>
                                              <span>{129}</span>
                                          <small className="text-danger ps-2">
                                            <FontAwesomeIcon icon={faAngleDown} />
                                          </small>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </ListGroupItem>
                                <ListGroupItem>
                                  <div className="widget-content p-0">
                                    <div className="widget-content-wrapper">
                                      <div className="widget-content-left me-3">
                                        <img width={42} className="rounded-circle" src={avatar2} alt=""/>
                                      </div>
                                      <div className="widget-content-left">
                                        <div className="widget-heading">
                                          Ruben Tillman
                                        </div>
                                        <div className="widget-subheading">
                                          UI Designer
                                        </div>
                                      </div>
                                      <div className="widget-content-right">
                                        <div className="font-size-xlg text-muted">
                                          <small className="opacity-5 pe-1">
                                            $
                                          </small>
                                              <span>{54}</span>
                                          <small className="text-success ps-2">
                                            <FontAwesomeIcon icon={faAngleUp} />
                                          </small>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </ListGroupItem>
                              </ListGroup>
                                </CustomScrollbar>
                          </div>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                  </Card>
                </Col>
              </Row>
              <div className="divider mt-0" style={{ marginBottom: "30px" }} />
              <Row>
                <Col md="6">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <CardTitle>Income Report</CardTitle>
                      <div className="widget-chart-wrapper widget-chart-wrapper-lg opacity-10 m-0">
                        <ResponsiveContainer width="100%" minWidth={1} minHeight={40} aspect={3.0 / 1.0}>
                              <LineChart data={this.state.analyticsData.map((value, index) => ({ name: `Point ${index}`, pv: value * 1000 + 2000, uv: value * 800 + 1500 }))} margin={{ top: 0, right: 5, left: 5, bottom: 0 }}>
                            <Tooltip />
                            <Line type="monotone" dataKey="pv" stroke="#d6b5ff" strokeWidth={2}/>
                            <Line type="monotone" dataKey="uv" stroke="#a75fff" strokeWidth={2}/>
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                      <Row>
                        <Col md="12" lg="4">
                          <div className="widget-content">
                            <div className="widget-content-outer">
                              <div className="widget-content-wrapper">
                                <div className="widget-content-left">
                                  <div className="widget-numbers text-dark">
                                    65%
                                  </div>
                                </div>
                              </div>
                              <div className="widget-progress-wrapper mt-1">
                                <Progress className="progress-bar-xs progress-bar-animated-alt" color="info" value="65"/>
                                <div className="progress-sub-label">
                                  <div className="sub-label-left font-size-md">
                                    Sales
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </Col>
                        <Col md="12" lg="4">
                          <div className="widget-content">
                            <div className="widget-content-outer">
                              <div className="widget-content-wrapper">
                                <div className="widget-content-left">
                                  <div className="widget-numbers text-dark">
                                    22%
                                  </div>
                                </div>
                              </div>
                              <div className="widget-progress-wrapper mt-1">
                                <Progress className="progress-bar-xs progress-bar-animated-alt" color="warning" value="22"/>
                                <div className="progress-sub-label">
                                  <div className="sub-label-left font-size-md">
                                    Profiles
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </Col>
                        <Col md="12" lg="4">
                          <div className="widget-content">
                            <div className="widget-content-outer">
                              <div className="widget-content-wrapper">
                                <div className="widget-content-left">
                                  <div className="widget-numbers text-dark">
                                    83%
                                  </div>
                                </div>
                              </div>
                              <div className="widget-progress-wrapper mt-1">
                                <Progress className="progress-bar-xs progress-bar-animated-alt" color="success" value="83"/>
                                <div className="progress-sub-label">
                                  <div className="sub-label-left font-size-md">
                                    Tickets
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </Col>
                      </Row>
                    </CardBody>
                  </Card>
                  <Card className="main-card mb-3">
                    <ListGroup flush>
                      <ListGroupItem>
                        <div className="widget-content p-0">
                          <div className="widget-chart-actions">
                            <UncontrolledButtonDropdown>
                              <DropdownToggle color="link">
                                <FontAwesomeIcon icon={faEllipsisH} />
                              </DropdownToggle>
                              <DropdownMenu className="dropdown-menu-lg rm-pointers dropdown-menu-right">
                                <div className="dropdown-menu-header">
                                  <div className="dropdown-menu-header-inner bg-primary">
                                    <div className="menu-header-image opacity-2"
                                      style={{
                                        backgroundImage: "url(" + bg1 + ")",
                                      }}>
                                  </div>
                                    <div className="menu-header-content">
                                      <div>
                                        <h5 className="menu-header-title">
                                          Settings
                                        </h5>
                                        <h6 className="menu-header-subtitle">
                                          Manage all of your options
                                        </h6>
                                      </div>
                                      <div className="menu-header-btn-pane">
                                        <Button size="sm" color="dark" className="me-2">
                                          Settings
                                        </Button>
                                        <Button size="sm" className="btn-icon btn-icon-only" color="warning">
                                          <i className="pe-7s-config btn-icon-wrapper"> {" "} </i>
                                        </Button>
                                      </div>
                                    </div>
                                  </div>
                                </div>
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
                                  <NavItem className="nav-item-divider" />
                                  <NavItem className="nav-item-btn">
                                    <Button size="sm" className="btn-wide btn-shadow" color="danger">
                                      Cancel
                                    </Button>
                                  </NavItem>
                                </Nav>
                              </DropdownMenu>
                            </UncontrolledButtonDropdown>
                          </div>
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left me-3">
                              <div className="icon-wrapper border-light rounded m-0">
                                <div className="icon-wrapper-bg bg-light" />
                                <i className="lnr-cog icon-gradient bg-happy-itmeo" />
                              </div>
                            </div>
                            <div className="widget-content-left ">
                              <div className="widget-heading">Product Sales</div>
                              <div className="widget-subheading opacity-10">
                                <span className="pe-2">
                                  <b>43</b> Sales
                                </span>
                                <span>
                                  <b className="text-success">$156,24</b> Totals
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </ListGroupItem>
                      <ListGroupItem>
                        <Row className="g-0">
                          <Col md="12" lg="9">
                            <div className="p-3">
                              <Radar data={data4} />
                            </div>
                          </Col>
                          <Col md="12" lg="3" className="align-self-center">
                            <div>
                              <div className="widget-chart p-0">
                                <div className="widget-chart-content">
                                  <div className="widget-numbers fsize-3">
                                    12.31k
                                  </div>
                                  <div className="widget-subheading pt-1">
                                    Product Views
                                  </div>
                                </div>
                              </div>
                              <div className="divider" />
                              <div className="widget-chart p-0">
                                <div className="widget-chart-content">
                                  <div className="widget-numbers fsize-3">
                                    $4.3M
                                  </div>
                                  <div className="widget-subheading pt-1">
                                    Total Sales
                                  </div>
                                </div>
                              </div>
                            </div>
                          </Col>
                        </Row>
                      </ListGroupItem>
                    </ListGroup>
                  </Card>
                </Col>
                <Col md="6">
                  <Card className="main-card mb-3">
                    <div className="dropdown-menu-header">
                      <div className="dropdown-menu-header-inner bg-focus">
                        <div className="menu-header-image opacity-3"
                          style={{
                            backgroundImage: "url(" + bg3 + ")",
                          }}/>
                        <div className="menu-header-content text-start">
                          <h5 className="menu-header-title">Settings</h5>
                          <h6 className="menu-header-subtitle">
                            Manage all of your options
                          </h6>
                          <div className="menu-header-btn-pane">
                            <Button size="sm" color="primary" className="me-2">
                              Settings
                            </Button>
                            <Button size="sm" className="btn-icon btn-icon-only" color="danger">
                              <i className="pe-7s-config btn-icon-wrapper"> </i>
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <CardHeader>
                      <div className="actions-icon-btn mx-auto">
                        <div>
                          <ButtonGroup size="lg">
                            <Button caret="true" color="focus"
                              className={
                                "btn-pill ps-3 " +
                                classnames({
                                  active: this.state.activeTab === "1",
                                })
                              }
                              onClick={() => {
                                this.toggle("1");
                              }}>
                              Income
                            </Button>
                            <Button color="focus"
                              className={
                                "btn-pill pe-3 " +
                                classnames({
                                  active: this.state.activeTab === "2",
                                })
                              }
                              onClick={() => {
                                this.toggle("2");
                              }}>
                              Expenses
                            </Button>
                          </ButtonGroup>
                        </div>
                      </div>
                    </CardHeader>
                    <TabContent activeTab={this.state.activeTab}>
                      <TabPane tabId="1">
                        <CardBody>
                          <h5 className="menu-header-title">Monthly Sales</h5>
                          <h6 className="menu-header-subtitle">
                            Total performance for this month
                          </h6>
                          <div className="chart-wrapper">
                                <ResponsiveContainer width="100%" height={250}>
                              <BarChart data={data2}>
                                <XAxis dataKey="name" />
                                <Legend />
                                <Bar barGap="12" dataKey="Sales" stackId="a" fill="#3f6ad8"/>
                                <Bar barGap="12" dataKey="Downloads" stackId="a" fill="#e0f3ff"/>
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </CardBody>
                      </TabPane>
                      <TabPane tabId="2">
                        <ListGroup flush>
                          <ListGroupItem>
                            <Row>
                              <Col md="7">
                                <Doughnut type='Doughnut' data={data} />
                              </Col>
                              <Col md="5" className="align-self-center">
                                <div>
                                  <div className="widget-chart p-0">
                                    <div className="widget-chart-content">
                                      <div className="widget-numbers fsize-3">
                                        12.31k
                                      </div>
                                      <div className="widget-subheading pt-1">
                                        Product Views
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-center mt-3">
                                    <Button outline className="border-0 btn-transition"  color="danger">
                                      Remove
                                    </Button>
                                    <Button outline className="border-0 btn-transition" color="success">
                                      Rename
                                    </Button>
                                  </div>
                                </div>
                              </Col>
                            </Row>
                          </ListGroupItem>
                        </ListGroup>
                      </TabPane>
                    </TabContent>
                  </Card>
                </Col>
              </Row>
              <div className="divider mt-0" style={{ marginBottom: "30px" }} />
              <Row>
                <Col md="12">
                  <Card className="main-card mb-3">
                    <ListGroup flush>
                      <ListGroupItem className="center-elem">
                        <div className="widget-content p-0">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left me-3">
                              <div className="icon-wrapper border-light rounded m-0">
                                <div className="icon-wrapper-bg bg-light" />
                                <i className="lnr-cog icon-gradient bg-happy-itmeo" />
                              </div>
                            </div>
                            <div className="widget-content-left ">
                              <div className="widget-heading">
                                <h5 className="menu-header-title text-capitalize">
                                  Performance
                                </h5>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="btn-actions-pane-right">
                          <ButtonGroup size="sm">
                            <Button caret="true" color="dark"
                              className={
                                "btn-shadow " +
                                classnames({
                                  active: this.state.activeTab === "1",
                                })
                              }
                              onClick={() => {
                                this.toggle("1");
                              }}>
                              Tab 1
                            </Button>
                            <Button caret="true" color="dark"
                              className={
                                "btn-shadow " +
                                classnames({
                                  active: this.state.activeTab === "2",
                                })
                              }
                              onClick={() => {
                                this.toggle("2");
                              }}>
                              Tab 2
                            </Button>
                            <Button color="dark"
                              className={
                                "btn-shadow " +
                                classnames({
                                  active: this.state.activeTab === "3",
                                })
                              }
                              onClick={() => {
                                this.toggle("3");
                              }}>
                              Tab 3
                            </Button>
                          </ButtonGroup>
                        </div>
                      </ListGroupItem>
                      <ListGroupItem>
                        <Row>
                          <Col sm="12" md="6" className="align-self-center">
                                <Sparklines height={90} data={[0.3, 0.7, -0.1, 0.4, -0.5, 0.8, 0.2, -0.3, 0.6, -0.4, 0.1, 0.9, -0.2, 0.5, -0.8]} limit={25}>
                              <SparklinesBars style={{ fill: "#41c3f9", fillOpacity: ".25" }}/>
                              <SparklinesLine style={{ stroke: "#41c3f9", fill: "none" }}/>
                            </Sparklines>
                          </Col>
                          <Col sm="12" md="6" className="align-self-center">
                            <Row>
                              <Col sm="12" md="6">
                                <div className="widget-chart">
                                  <div className="widget-chart-content">
                                    <div className="widget-numbers text-warning fsize-3">
                                      158
                                    </div>
                                    <div className="widget-subheading pt-1">
                                      Bug Reports
                                    </div>
                                  </div>
                                </div>
                                <div className="divider" />
                                <div className="widget-chart">
                                  <div className="widget-chart-content">
                                    <div className="widget-numbers text-success fsize-3">
                                      346
                                    </div>
                                    <div className="widget-subheading pt-1">
                                      Dropped Packages
                                    </div>
                                  </div>
                                </div>
                              </Col>
                              <Col sm="12" md="6">
                                <div className="widget-chart">
                                  <div className="widget-chart-content">
                                    <div className="widget-numbers text-info fsize-3">
                                      12.31k
                                    </div>
                                    <div className="widget-subheading pt-1">
                                      Page Views
                                    </div>
                                  </div>
                                </div>
                                <div className="divider" />
                                <div className="widget-chart">
                                  <div className="widget-chart-content">
                                    <div className="widget-numbers fsize-3">
                                      632
                                    </div>
                                    <div className="widget-subheading pt-1">
                                      Agents Online
                                    </div>
                                  </div>
                                </div>
                              </Col>
                            </Row>
                          </Col>
                        </Row>
                      </ListGroupItem>
                    </ListGroup>
                  </Card>
                  <Card className="main-card mb-3">
                    <ListGroup flush>
                      <ListGroupItem>
                        <Row>
                          <Col md="6" className="align-self-center">
                                <Sparklines height={90} data={[0.5, -0.2, 0.8, -0.3, 0.1, 0.7, -0.4, 0.2, -0.6, 0.9, 0.3, 0.7, -0.1, 0.4, -0.5, 0.8, 0.2, -0.3, 0.6, -0.4]} limit={150}>
                              <SparklinesBars style={{ fill: "#41c3f9", fillOpacity: ".25" }}/>
                              <SparklinesLine style={{ stroke: "#41c3f9", fill: "none" }}/>
                            </Sparklines>
                          </Col>
                          <Col md="6" className="align-self-center">
                            <Row>
                              <Col md="6">
                                <div className="widget-chart">
                                  <div className="widget-chart-content">
                                    <div className="widget-numbers text-warning fsize-3">
                                      158
                                    </div>
                                    <div className="widget-subheading pt-1">
                                      Bug Reports
                                    </div>
                                  </div>
                                </div>
                              </Col>
                              <Col md="6">
                                <div className="widget-chart">
                                  <div className="widget-chart-content">
                                    <div className="widget-numbers text-info fsize-3">
                                      12.31k
                                    </div>
                                    <div className="widget-subheading pt-1">
                                      Page Views
                                    </div>
                                  </div>
                                </div>
                              </Col>
                            </Row>
                          </Col>
                        </Row>
                      </ListGroupItem>
                    </ListGroup>
                  </Card>
                </Col>
              </Row>
                </TabPane>
                <TabPane tabId="dynamic">
                  {/* Dynamic Charts Section */}
                  <Row>
                    <Col md="12">
                      <div className="d-flex justify-content-center mb-4">
                        <div className="text-center">
                          <h4 className="text-primary">
                            <i className="fa fa-bolt me-2"></i>
                            Live Updating Charts
                          </h4>
                          <p className="text-muted">
                            These charts update every 2 seconds with real-time data
                          </p>
                        </div>
                      </div>
                    </Col>
                  </Row>
                  
                  <Row>
                    {/* Dynamic Servers Chart */}
                    <Col md="12" lg="4">
                      <Card className="mb-3">
                        <CardHeader className="h-auto p-3">
                          <div>
                            <h5 className="menu-header-title text-capitalize">
                              <i className="fa fa-server me-2 text-primary"></i>
                              Servers (Live)
                            </h5>
                            <h6 className="menu-header-subtitle text-capitalize opacity-8">
                              Real-time server metrics
                            </h6>
                          </div>
                        </CardHeader>
                        <CardBody>
                          <Row>
                            <Col md="4">
                              <div className="widget-chart d-flex align-self-center he-100 p-0">
                                <div className="widget-chart-content mx-auto center-elem">
                                  <div className="widget-numbers text-danger fsize-4">
                                    <small className="text-muted opacity-5 pe-1">$</small>
                                    2.2M
                                  </div>
                                </div>
                              </div>
                            </Col>
                            <Col md="8">
                              <div className="chart-wrapper">
                                <ResponsiveContainer width="100%" height={250}>
                                  <Sparklines height={90} data={this.state.serversData} limit={25}>
                                    <SparklinesBars style={{ fill: "#41c3f9", fillOpacity: ".25" }}/>
                                    <SparklinesLine style={{ stroke: "#41c3f9", fill: "none" }}/>
                                  </Sparklines>
                                </ResponsiveContainer>
                              </div>
                            </Col>
                          </Row>
                        </CardBody>
                      </Card>
                    </Col>

                    {/* Dynamic Performance Chart */}
                    <Col md="12" lg="4">
                      <Card className="mb-3">
                        <CardHeader className="h-auto p-3">
                          <div>
                            <h5 className="menu-header-title text-capitalize">
                              <i className="fa fa-tachometer-alt me-2 text-success"></i>
                              Performance (Live)
                            </h5>
                            <h6 className="menu-header-subtitle text-capitalize opacity-8">
                              Real-time performance data
                            </h6>
                          </div>
                        </CardHeader>
                        <CardBody>
                          <Row>
                            <Col sm="12" md="6" className="align-self-center">
                              <Sparklines height={90} data={this.state.performanceData} limit={25}>
                                <SparklinesBars style={{ fill: "#41c3f9", fillOpacity: ".25" }}/>
                                <SparklinesLine style={{ stroke: "#41c3f9", fill: "none" }}/>
                              </Sparklines>
                            </Col>
                            <Col sm="12" md="6" className="align-self-center">
                              <Row>
                                <Col sm="12" md="6">
                                  <div className="widget-chart">
                                    <div className="widget-chart-content">
                                      <div className="widget-numbers text-warning fsize-3">
                                        158
                                      </div>
                                      <div className="widget-subheading pt-1">
                                        Bug Reports
                                      </div>
                                    </div>
                                  </div>
                                </Col>
                                <Col sm="12" md="6">
                                  <div className="widget-chart">
                                    <div className="widget-chart-content">
                                      <div className="widget-numbers text-info fsize-3">
                                        12.31k
                                      </div>
                                      <div className="widget-subheading pt-1">
                                        Page Views
                                      </div>
                                    </div>
                                  </div>
                                </Col>
                              </Row>
                            </Col>
                          </Row>
                        </CardBody>
                      </Card>
                    </Col>

                    {/* Dynamic Analytics Chart */}
                    <Col md="12" lg="4">
                      <Card className="mb-3">
                        <CardHeader>
                          <h5 className="menu-header-title">
                            <i className="fa fa-chart-line me-2 text-warning"></i>
                            Analytics (Live)
                          </h5>
                        </CardHeader>
                        <CardBody>
                          <div className="widget-chart-wrapper widget-chart-wrapper-lg opacity-10 m-0">
                            <ResponsiveContainer width="100%" minWidth={1} minHeight={40} aspect={2.0 / 1.0}>
                              <LineChart data={this.state.analyticsData.map((value, index) => ({ name: `Point ${index}`, pv: value * 1000 + 2000, uv: value * 800 + 1500 }))} margin={{ top: 0, right: 5, left: 5, bottom: 0 }}>
                                <Tooltip />
                                <Line type="monotone" dataKey="pv" stroke="#d6b5ff" strokeWidth={2}/>
                                <Line type="monotone" dataKey="uv" stroke="#a75fff" strokeWidth={2}/>
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        </CardBody>
                      </Card>
                    </Col>
                  </Row>

                  <Row>
                    <Col md="12">
                      <div className="text-center">
                        <div className="alert alert-info">
                          <i className="fa fa-info-circle me-2"></i>
                          <strong>Live Data:</strong> These charts update automatically every 2 seconds. 
                          Switch to "Static Charts" tab to view stable chart visualizations.
                        </div>
                      </div>
                    </Col>
                  </Row>
                </TabPane>
              </TabContent>
            </div>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}

export default BasicExample;
