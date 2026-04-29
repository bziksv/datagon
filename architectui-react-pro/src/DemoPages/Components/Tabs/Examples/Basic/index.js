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
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Button,
  ButtonGroup,
  Container,
} from "reactstrap";

import { faCommentDots, faBullhorn } from "@fortawesome/free-solid-svg-icons";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

export default class TabsExample extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      activeTab1: "1",  // For first tab example
      activeTab2: "1",  // For second tab example  
      activeTab3: "1",  // For third tab example
      activeTab4: "1",  // For fourth tab example
      activeTab5: "1",  // For fifth tab example
      activeTab6: "1",  // For sixth tab example
      activeTab7: "1",  // For seventh tab example
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

  render() {
    return (
      <Fragment>
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={0} enter={false} exit={false}>
            <Container fluid>
              <Row>
                <Col md="12">
                  <Card className="mb-3">
                    <CardHeader className="tabs-lg-alternate">
                      <Nav justified>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab1 === "1",
                            })}
                            onClick={() => {
                              this.toggle1("1");
                            }}>
                            <div className="widget-number">Tab 1</div>
                            <div className="tab-subheading">
                              <span className="pe-2 opacity-6">
                                <FontAwesomeIcon icon={faCommentDots} />
                              </span>
                              Totals
                            </div>
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
                            <div className="widget-number">Tab 2</div>
                            <div className="tab-subheading">Products</div>
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
                            <div className="widget-number text-danger">Tab 3</div>
                            <div className="tab-subheading">
                              <span className="pe-2 opacity-6">
                                <FontAwesomeIcon icon={faBullhorn} />
                              </span>
                              Income
                            </div>
                          </NavLink>
                        </NavItem>
                      </Nav>
                    </CardHeader>
                    <TabContent activeTab={this.state.activeTab1}>
                      <TabPane tabId="1">
                        <CardBody>
                          <p className="mb-0">
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
                          </p>
                        </CardBody>
                      </TabPane>
                      <TabPane tabId="2">
                        <CardBody>
                          <p className="mb-0">
                            Lorem Ipsum is simply dummy text of the printing and
                            typesetting industry. Lorem Ipsum has been the
                            industry's standard dummy text ever since the 1500s,
                            when an unknown printer took a galley of type and
                            scrambled it to make a type specimen book. It has
                            survived not only five centuries, but also the leap
                            into electronic typesetting, remaining essentially
                            unchanged.{" "}
                          </p>
                        </CardBody>
                      </TabPane>
                      <TabPane tabId="3">
                        <CardBody>
                          <p className="mb-0">
                            It was popularised in the 1960s with the release of
                            Letraset sheets containing Lorem Ipsum passages, and
                            more recently with desktop publishing software like
                            Aldus PageMaker including versions of Lorem Ipsum.
                          </p>
                        </CardBody>
                      </TabPane>
                    </TabContent>
                  </Card>
                </Col>
                <Col md="6">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <CardTitle>Basic</CardTitle>
                      <Nav>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab2 === "1",
                            })}
                            onClick={() => {
                              this.toggle2("1");
                            }}>
                            Tab 1
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab2 === "2",
                            })}
                            onClick={() => {
                              this.toggle2("2");
                            }}>
                            Tab 2
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab2 === "3",
                            })}
                            onClick={() => {
                              this.toggle2("3");
                            }}>
                            Tab 3
                          </NavLink>
                        </NavItem>
                      </Nav>
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
                            Lorem Ipsum is simply dummy text of the printing and
                            typesetting industry. Lorem Ipsum has been the
                            industry's standard dummy text ever since the 1500s,
                            when an unknown printer took a galley of type and
                            scrambled it to make a type specimen book. It has
                            survived not only five centuries, but also the leap
                            into electronic typesetting, remaining essentially
                            unchanged.{" "}
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
                    <CardBody>
                      <CardTitle>Justified Alignment</CardTitle>
                      <Nav justified>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab3 === "1",
                            })}
                            onClick={() => {
                              this.toggle3("1");
                            }}>
                            Tab 1
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab3 === "2",
                            })}
                            onClick={() => {
                              this.toggle3("2");
                            }}>
                            Tab 2
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab3 === "3",
                            })}
                            onClick={() => {
                              this.toggle3("3");
                            }}>
                            Tab 3
                          </NavLink>
                        </NavItem>
                      </Nav>
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
                            Lorem Ipsum is simply dummy text of the printing and
                            typesetting industry. Lorem Ipsum has been the
                            industry's standard dummy text ever since the 1500s,
                            when an unknown printer took a galley of type and
                            scrambled it to make a type specimen book. It has
                            survived not only five centuries, but also the leap
                            into electronic typesetting, remaining essentially
                            unchanged.{" "}
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
                    <CardBody>
                      <CardTitle>Tabs Variations</CardTitle>
                      <div className="mb-3">
                        <ButtonGroup size="sm">
                          <Button caret="true" color="warning"
                            className={
                              "btn-pill ps-3 " +
                              classnames({ active: this.state.activeTab4 === "1" })
                            }
                            onClick={() => {
                              this.toggle4("1");
                            }}>
                            Tab 1
                          </Button>
                          <Button color="warning"
                            className={classnames({
                              active: this.state.activeTab4 === "2",
                            })}
                            onClick={() => {
                              this.toggle4("2");
                            }}>
                            Tab 2
                          </Button>
                          <Button color="warning"
                            className={
                              "btn-pill pe-3 " +
                              classnames({ active: this.state.activeTab4 === "3" })
                            }
                            onClick={() => {
                              this.toggle4("3");
                            }}>
                            Tab 3
                          </Button>
                        </ButtonGroup>
                      </div>
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
                            Lorem Ipsum is simply dummy text of the printing and
                            typesetting industry. Lorem Ipsum has been the
                            industry's standard dummy text ever since the 1500s,
                            when an unknown printer took a galley of type and
                            scrambled it to make a type specimen book. It has
                            survived not only five centuries, but also the leap
                            into electronic typesetting, remaining essentially
                            unchanged.{" "}
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
                </Col>
                <Col md="6">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <CardTitle>Pills</CardTitle>
                      <Nav pills>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab5 === "1",
                            })}
                            onClick={() => {
                              this.toggle5("1");
                            }}>
                            Pill 1
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab5 === "2",
                            })}
                            onClick={() => {
                              this.toggle5("2");
                            }}>
                            Pill 2
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab5 === "3",
                            })}
                            onClick={() => {
                              this.toggle5("3");
                            }}>
                            Pill 3
                          </NavLink>
                        </NavItem>
                      </Nav>
                      <TabContent activeTab={this.state.activeTab5}>
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
                            Lorem Ipsum is simply dummy text of the printing and
                            typesetting industry. Lorem Ipsum has been the
                            industry's standard dummy text ever since the 1500s,
                            when an unknown printer took a galley of type and
                            scrambled it to make a type specimen book. It has
                            survived not only five centuries, but also the leap
                            into electronic typesetting, remaining essentially
                            unchanged.{" "}
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
                    <CardBody>
                      <CardTitle>Pills</CardTitle>
                      <Nav pills fill>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab6 === "1",
                            })}
                            onClick={() => {
                              this.toggle6("1");
                            }}>
                            Pill 1
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab6 === "2",
                            })}
                            onClick={() => {
                              this.toggle6("2");
                            }}>
                            Pill 2
                          </NavLink>
                        </NavItem>
                        <NavItem>
                          <NavLink href="#"
                            className={classnames({
                              active: this.state.activeTab6 === "3",
                            })}
                            onClick={() => {
                              this.toggle6("3");
                            }}>
                            Pill 3
                          </NavLink>
                        </NavItem>
                      </Nav>
                      <TabContent activeTab={this.state.activeTab6}>
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
                            Lorem Ipsum is simply dummy text of the printing and
                            typesetting industry. Lorem Ipsum has been the
                            industry's standard dummy text ever since the 1500s,
                            when an unknown printer took a galley of type and
                            scrambled it to make a type specimen book. It has
                            survived not only five centuries, but also the leap
                            into electronic typesetting, remaining essentially
                            unchanged.{" "}
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
                    <CardBody>
                      <CardTitle>Button Group Tabs</CardTitle>
                      <div className="mb-3 text-center">
                        <ButtonGroup size="sm">
                          <Button caret="true" color="primary"
                            className={
                              "btn-shadow " +
                              classnames({ active: this.state.activeTab7 === "1" })
                            }
                            onClick={() => {
                              this.toggle7("1");
                            }}>
                            Tab 1
                          </Button>
                          <Button color="primary"
                            className={
                              "btn-shadow " +
                              classnames({ active: this.state.activeTab7 === "2" })
                            }
                            onClick={() => {
                              this.toggle7("2");
                            }}>
                            Tab 2
                          </Button>
                          <Button color="primary"
                            className={
                              "btn-shadow " +
                              classnames({ active: this.state.activeTab7 === "3" })
                            }
                            onClick={() => {
                              this.toggle7("3");
                            }}>
                            Tab 3
                          </Button>
                        </ButtonGroup>
                      </div>
                      <TabContent activeTab={this.state.activeTab7}>
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
                            Lorem Ipsum has been the industry's standard dummy
                            text ever since the 1500s, when an unknown printer
                            took a galley of type and scrambled it to make a type
                            specimen book. It has survived not only five
                            centuries, but also the leap into electronic
                            typesetting, remaining essentially unchanged.{" "}
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
                </Col>
              </Row>
            </Container>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}
