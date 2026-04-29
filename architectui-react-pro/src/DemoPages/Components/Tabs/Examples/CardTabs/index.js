import React, { Fragment } from "react";
import { CSSTransition, TransitionGroup } from "../../../../../components/React19Transition";
import classnames from "classnames";

import {
  TabContent,
  TabPane,
  Nav,
  NavItem,
  NavLink,
  Row,
  Col,
  CardHeader,
  CardFooter,
  Card,
  CardBody,
  Button,
  ButtonGroup,
  Container,
} from "reactstrap";

import AnimatedLinesTabsExample from "../AnimatedLines";

import dummyData from "../dummyData";

export default class CardTabsExample extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      activeTab1: "1",  // For first card tab example
      activeTab2: "1",  // For second card tab example
      activeTab3: "1",  // For third card tab example
      activeTab4: "1",  // For fourth card tab example
      activeTab5: "1",  // For fifth card tab example
      activeTab6: "1",  // For sixth card tab example
      activeTab7: "1",  // For seventh card tab example
      showMore: true,
      transform: true,
      showInkBar: true,
      items: this.getSimpleTabs(),
      selectedTabKey: 0,
      transformWidth: 400,
    };
  }

  toggle1 = (tab) => {
    if (this.state.activeTab1 !== tab) {
      this.setState({ activeTab1: tab });
    }
  }

  toggle2 = (tab) => {
    if (this.state.activeTab2 !== tab) {
      this.setState({ activeTab2: tab });
    }
  }

  toggle3 = (tab) => {
    if (this.state.activeTab3 !== tab) {
      this.setState({ activeTab3: tab });
    }
  }

  toggle4 = (tab) => {
    if (this.state.activeTab4 !== tab) {
      this.setState({ activeTab4: tab });
    }
  }

  toggle5 = (tab) => {
    if (this.state.activeTab5 !== tab) {
      this.setState({ activeTab5: tab });
    }
  }

  toggle6 = (tab) => {
    if (this.state.activeTab6 !== tab) {
      this.setState({ activeTab6: tab });
    }
  }

  toggle7 = (tab) => {
    if (this.state.activeTab7 !== tab) {
      this.setState({ activeTab7: tab });
    }
  }

  onChangeProp = (propsName) => (evt) => {
    this.setState({
      [propsName]:
        evt.target.type === "checkbox" ? evt.target.checked : +evt.target.value,
    });
  };

  getSimpleTabs = () =>
    dummyData.map(({ name, biography }, index) => ({
      key: index,
      title: name,
      getContent: () => biography,
    }));

  render() {
    return (
      <Fragment>
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={0} enter={false} exit={false}>
            <Container fluid>
              <Row>
                <Col md="6">
                  <Card className="main-card mb-3">
                    <CardHeader>
                      <i className="header-icon lnr-license icon-gradient bg-plum-plate"> {" "} </i>
                      Header with Tabs
                      <div className="btn-actions-pane-right">
                        <ButtonGroup size="sm">
                          <Button color="primary"
                            className={
                              "btn-shadow " +
                              classnames({ active: this.state.activeTab1 === "1" })
                            }
                            onClick={() => {
                              this.toggle1("1");
                            }}>
                            Tab 1
                          </Button>
                          <Button color="primary"
                            className={
                              "btn-shadow " +
                              classnames({ active: this.state.activeTab1 === "2" })
                            }
                            onClick={() => {
                              this.toggle1("2");
                            }}>
                            Tab 2
                          </Button>
                          <Button color="primary"
                            className={
                              "btn-shadow " +
                              classnames({ active: this.state.activeTab1 === "3" })
                            }
                            onClick={() => {
                              this.toggle1("3");
                            }}>
                            Tab 3
                          </Button>
                        </ButtonGroup>
                      </div>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab1}>
                        <TabPane tabId="1">
                          <p>
                            It was popularised in the 1960s with the release of
                            Letraset sheets containing Lorem Ipsum passages, and
                            more recently with desktop publishing software like
                            Aldus PageMaker including versions of Lorem Ipsum.
                          </p>
                        </TabPane>
                        <TabPane tabId="2">
                          <p>
                            Like Aldus PageMaker including versions of Lorem. It
                            has survived not only five centuries, but also the
                            leap into electronic typesetting, remaining
                            essentially unchanged.{" "}
                          </p>
                        </TabPane>
                        <TabPane tabId="3">
                          <p>
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
                          </p>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                    <CardFooter className="d-block text-end">
                      <Button className="btn-wide" color="success">
                        Save
                      </Button>
                    </CardFooter>
                  </Card>
                  <Card className="main-card mb-3">
                    <CardHeader>
                      <i className="header-icon lnr-license icon-gradient bg-plum-plate"> {" "} </i>
                      Header Tabs Buttons
                      <div className="btn-actions-pane-right">
                        <Button size="sm" outline color="alternate"
                          className={
                            "btn-pill btn-wide " +
                            classnames({ active: this.state.activeTab2 === "1" })
                          }
                          onClick={() => {
                            this.toggle2("1");
                          }}>
                          Tab 1
                        </Button>
                        <Button size="sm" outline color="alternate"
                          className={
                            "btn-pill btn-wide me-1 ms-1 " +
                            classnames({ active: this.state.activeTab2 === "2" })
                          }
                          onClick={() => {
                            this.toggle2("2");
                          }}>
                          Tab 2
                        </Button>
                        <Button size="sm" outline color="alternate"
                          className={
                            "btn-pill btn-wide " +
                            classnames({ active: this.state.activeTab2 === "3" })
                          }
                          onClick={() => {
                            this.toggle2("3");
                          }}>
                          Tab 3
                        </Button>
                      </div>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab2}>
                        <TabPane tabId="1">
                          <p>
                            It was popularised in the 1960s with the release of
                            Letraset sheets containing Lorem Ipsum passages, and
                            more recently with desktop publishing software like
                            Aldus PageMaker including versions of Lorem Ipsum.
                          </p>
                        </TabPane>
                        <TabPane tabId="2">
                          <p>
                            Like Aldus PageMaker including versions of Lorem. It
                            has survived not only five centuries, but also the
                            leap into electronic typesetting, remaining
                            essentially unchanged.{" "}
                          </p>
                        </TabPane>
                        <TabPane tabId="3">
                          <p>
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
                          </p>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                    <CardFooter className="d-block text-end">
                      <Button className="btn-wide" color="success">
                        Save
                      </Button>
                    </CardFooter>
                  </Card>
                  <Card className="main-card mb-3">
                    <CardHeader>
                      <i className="header-icon lnr-gift icon-gradient bg-mixed-hopes"> {" "} </i>
                      Alternate Tabs
                      <div className="btn-actions-pane-right">
                        <ButtonGroup size="sm">
                          <Button color="focus"
                            className={
                              "btn-pill ps-3 " +
                              classnames({ active: this.state.activeTab3 === "1" })
                            }
                            onClick={() => {
                              this.toggle3("1");
                            }}>
                            Tab 1
                          </Button>
                          <Button color="focus"
                            className={classnames({
                              active: this.state.activeTab3 === "2",
                            })}
                            onClick={() => {
                              this.toggle3("2");
                            }}>
                            Tab 2
                          </Button>
                          <Button color="focus"
                            className={
                              "btn-pill pe-3 " +
                              classnames({ active: this.state.activeTab3 === "3" })
                            }
                            onClick={() => {
                              this.toggle3("3");
                            }}>
                            Tab 3
                          </Button>
                        </ButtonGroup>
                      </div>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab3}>
                        <TabPane tabId="1">
                          <p>
                            It was popularised in the 1960s with the release of
                            Letraset sheets containing Lorem Ipsum passages, and
                            more recently with desktop publishing software like
                            Aldus PageMaker including versions of Lorem Ipsum.
                          </p>
                        </TabPane>
                        <TabPane tabId="2">
                          <p>
                            Like Aldus PageMaker including versions of Lorem. It
                            has survived not only five centuries, but also the
                            leap into electronic typesetting, remaining
                            essentially unchanged.{" "}
                          </p>
                        </TabPane>
                        <TabPane tabId="3">
                          <p>
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
                          </p>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                  </Card>
                  <Card className="main-card mb-3">
                    <CardHeader>
                      <i className="header-icon lnr-gift icon-gradient bg-grow-early">
                        {" "}
                      </i>
                      Header Tabs Standard Buttons
                      <div className="btn-actions-pane-right">
                        <Button outline
                          className={
                            "border-0 btn-pill btn-wide btn-transition " +
                            classnames({ active: this.state.activeTab1 === "1" })
                          }
                          color="danger"
                          onClick={() => {
                            this.toggle1("1");
                          }}>
                          Tab 1
                        </Button>
                        <Button outline
                          className={
                            "me-1 ms-1 btn-pill btn-wide border-0 btn-transition " +
                            classnames({ active: this.state.activeTab1 === "2" })
                          }
                          color="danger"
                          onClick={() => {
                            this.toggle1("2");
                          }}>
                          Tab 2
                        </Button>
                        <Button outline
                          className={
                            "border-0 btn-pill btn-wide btn-transition " +
                            classnames({ active: this.state.activeTab1 === "3" })
                          }
                          color="danger"
                          onClick={() => {
                            this.toggle1("3");
                          }}>
                          Tab 3
                        </Button>
                      </div>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab1}>
                        <TabPane tabId="1">
                          <p>
                            It was popularised in the 1960s with the release of
                            Letraset sheets containing Lorem Ipsum passages, and
                            more recently with desktop publishing software like
                            Aldus PageMaker including versions of Lorem Ipsum.
                          </p>
                        </TabPane>
                        <TabPane tabId="2">
                          <p>
                            Like Aldus PageMaker including versions of Lorem. It
                            has survived not only five centuries, but also the
                            leap into electronic typesetting, remaining
                            essentially unchanged.{" "}
                          </p>
                        </TabPane>
                        <TabPane tabId="3">
                          <p>
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
                          </p>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                    <CardFooter className="d-block text-end">
                      <Button className="btn-wide" color="success">
                        Save
                      </Button>
                    </CardFooter>
                  </Card>
                </Col>
                <Col md="6">
                  <Card className="mb-3">
                    <CardHeader className="card-header-tab">
                      <div className="card-header-title">
                        <i className="header-icon lnr-bicycle icon-gradient bg-love-kiss"> {" "} </i>
                        Header Alternate Tabs
                      </div>
                      <Nav>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab4 === "1",
                            })}
                            onClick={() => {
                              this.toggle4("1");
                            }}>
                            Tab 1
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab4 === "2",
                            })}
                            onClick={() => {
                              this.toggle4("2");
                            }}>
                            Tab 2
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab4 === "3",
                            })}
                            onClick={() => {
                              this.toggle4("3");
                            }}>
                            Tab 3
                          </NavLink>
                        </NavItem>
                      </Nav>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab4}>
                        <TabPane tabId="1">
                          <p>
                            It was popularised in the 1960s with the release of
                            Letraset sheets containing Lorem Ipsum passages, and
                            more recently with desktop publishing software like
                            Aldus PageMaker including versions of Lorem Ipsum.
                          </p>
                        </TabPane>
                        <TabPane tabId="2">
                          <p>
                            Like Aldus PageMaker including versions of Lorem. It
                            has survived not only five centuries, but also the
                            leap into electronic typesetting, remaining
                            essentially unchanged.{" "}
                          </p>
                        </TabPane>
                        <TabPane tabId="3">
                          <p>
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
                          </p>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                    <CardFooter className="d-block text-end">
                      <Button className="btn-wide btn-shadow" color="danger">
                        Delete
                      </Button>
                    </CardFooter>
                  </Card>
                  <Card className="main-card mb-3">
                    <CardHeader>
                      <i className="header-icon lnr-gift icon-gradient bg-grow-early"> {" "} </i>
                      Header Tabs Standard Buttons
                      <div className="btn-actions-pane-right">
                        <Button outline
                          className={
                            "border-0 btn-transition " +
                            classnames({ active: this.state.activeTab1 === "1" })
                          }
                          color="primary"
                          onClick={() => {
                            this.toggle1("1");
                          }}>
                          Tab 1
                        </Button>
                        <Button outline
                          className={
                            "me-1 ms-1 border-0 btn-transition " +
                            classnames({ active: this.state.activeTab1 === "2" })
                          }
                          color="primary"
                          onClick={() => {
                            this.toggle1("2");
                          }}>
                          Tab 2
                        </Button>
                        <Button outline
                          className={
                            "border-0 btn-transition " +
                            classnames({ active: this.state.activeTab1 === "3" })
                          }
                          color="primary"
                          onClick={() => {
                            this.toggle1("3");
                          }}>
                          Tab 3
                        </Button>
                      </div>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab1}>
                        <TabPane tabId="1">
                          <p>
                            It was popularised in the 1960s with the release of
                            Letraset sheets containing Lorem Ipsum passages, and
                            more recently with desktop publishing software like
                            Aldus PageMaker including versions of Lorem Ipsum.
                          </p>
                        </TabPane>
                        <TabPane tabId="2">
                          <p>
                            Like Aldus PageMaker including versions of Lorem. It
                            has survived not only five centuries, but also the
                            leap into electronic typesetting, remaining
                            essentially unchanged.{" "}
                          </p>
                        </TabPane>
                        <TabPane tabId="3">
                          <p>
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
                          </p>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                    <CardFooter className="d-block text-end">
                      <Button className="btn-wide" color="success">
                        Save
                      </Button>
                    </CardFooter>
                  </Card>
                  <Card className="mb-3">
                    <CardHeader>
                      <Nav justified>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab1 === "1",
                            })}
                            onClick={() => {
                              this.toggle1("1");
                            }}>
                            Tab 1
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab1 === "2",
                            })}
                            onClick={() => {
                              this.toggle1("2");
                            }}>
                            Tab 2
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab1 === "3",
                            })}
                            onClick={() => {
                              this.toggle1("3");
                            }}>
                            Tab 3
                          </NavLink>
                        </NavItem>
                      </Nav>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab1}>
                        <TabPane tabId="1">
                          <p>
                            It was popularised in the 1960s with the release of
                            Letraset sheets containing Lorem Ipsum passages, and
                            more recently with desktop publishing software like
                            Aldus PageMaker including versions of Lorem Ipsum.
                          </p>
                        </TabPane>
                        <TabPane tabId="2">
                          <p>
                            Like Aldus PageMaker including versions of Lorem. It
                            has survived not only five centuries, but also the
                            leap into electronic typesetting, remaining
                            essentially unchanged.{" "}
                          </p>
                        </TabPane>
                        <TabPane tabId="3">
                          <p>
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
                          </p>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                  </Card>
                  <Card className="mb-3">
                    <CardHeader className="card-header-tab card-header-tab-animation">
                      <div className="card-header-title font-size-lg text-capitalize fw-normal">
                        <i className="header-icon lnr-gift icon-gradient bg-love-kiss"> {" "} </i>
                        Tabs Alternate Animation
                      </div>
                      <Nav>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab1 === "1",
                            })}
                            onClick={() => {
                              this.toggle1("1");
                            }}>
                            Tab 1
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab1 === "2",
                            })}
                            onClick={() => {
                              this.toggle1("2");
                            }}>
                            Tab 2
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab1 === "3",
                            })}
                            onClick={() => {
                              this.toggle1("3");
                            }}>
                            Tab 3
                          </NavLink>
                        </NavItem>
                      </Nav>
                    </CardHeader>
                    <CardBody>
                      <TabContent activeTab={this.state.activeTab1}>
                        <TabPane tabId="1">
                          <p>
                            It was popularised in the 1960s with the release of
                            Letraset sheets containing Lorem Ipsum passages, and
                            more recently with desktop publishing software like
                            Aldus PageMaker including versions of Lorem Ipsum.
                          </p>
                        </TabPane>
                        <TabPane tabId="2">
                          <p>
                            Like Aldus PageMaker including versions of Lorem. It
                            has survived not only five centuries, but also the
                            leap into electronic typesetting, remaining
                            essentially unchanged.{" "}
                          </p>
                        </TabPane>
                        <TabPane tabId="3">
                          <p>
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
                          </p>
                        </TabPane>
                      </TabContent>
                    </CardBody>
                    <CardFooter className="d-block text-center">
                      <Button className="btn-wide" color="link">
                        Link Button
                      </Button>
                      <Button className="btn-wide btn-shadow" color="danger">
                        Delete
                      </Button>
                    </CardFooter>
                  </Card>
                </Col>
              </Row>
              <AnimatedLinesTabsExample />
            </Container>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}
