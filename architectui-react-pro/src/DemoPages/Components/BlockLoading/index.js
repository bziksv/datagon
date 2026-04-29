import React, { Component, Fragment } from "react";
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";
import classnames from "classnames";
import { Tab, Tabs, TabList, TabPanel } from "react-tabs";
import 'react-tabs/style/react-tabs.css';

import {
  Row,
  Col,
  Form,
  FormGroup,
  Input,
  TabContent,
  TabPane,
  Nav,
  NavItem,
  NavLink,
  Card,
  CardBody,
  CardTitle,
  CardHeader,
  CardFooter,
  Button,
  ButtonGroup,
  UncontrolledButtonDropdown,
  DropdownToggle,
  DropdownMenu,
  DropdownItem,
} from "reactstrap";

import PageTitle from "../../../Layout/AppMain/PageTitle";

import dummyData from "./dummyData";

// React 19 compatible loading overlay component
const LoadingOverlay = ({ active, children, className }) => {
  return (
    <div className={className} style={{ position: "relative" }}>
      {active && (
        <div style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(255, 255, 255, 0.8)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          borderRadius: "inherit"
        }}>
          <div className="spinner-border text-primary" role="status" style={{ width: "3rem", height: "3rem" }}>
            <span className="visually-hidden">Loading...</span>
          </div>
        </div>
      )}
      <div style={{ opacity: active ? 0.5 : 1 }}>
        {children}
      </div>
    </div>
  );
};

class BlockLoadingExample extends Component {
  constructor(props) {
    super(props);

    this.toggleBlocking = this.toggleBlocking.bind(this);
    this.toggle = this.toggle.bind(this);
    
    this.state = {
      activeTab: "1",
      showMore: true,
      transform: true,
      showInkBar: true,
      items: this.getSimpleTabs(),
      selectedTabKey: 0,
      transformWidth: 400,
      active: false,
    };
  }

  toggleBlocking() {
    this.setState({ active: !this.state.active });
  }

  toggle(tab) {
    if (this.state.activeTab !== tab) {
      this.setState({
        activeTab: tab,
      });
    }
  }

  getSimpleTabs = () =>
    dummyData.map(({ name, biography }, index) => ({
      key: index,
      title: name,
      getContent: () => biography,
    }));

  render() {
    return (
      <Fragment>
        <PageTitle 
          heading="Block Loading"
          subheading="Sometimes we need to show a loading indicator for some elements, like cards or tables."
          icon="pe-7s-door-lock icon-gradient bg-night-fade"
        />
          <TransitionGroup>
            <CSSTransition component="div" classNames="TabsAnimation" appear={true}
              timeout={1500} enter={false} exit={false}>
              <div>  
                <Row>
                  <Col md="6">
                    <Card className="main-card mb-3">
                      <CardBody>
                      <CardTitle>Loading Control</CardTitle>
                        <Form className="mt-4">
                        <FormGroup>
                              <Button onClick={this.toggleBlocking} block color="primary">
                            {this.state.active ? 'Stop Loading' : 'Start Loading'}
                              </Button>
                          </FormGroup>
                        </Form>
                      </CardBody>
                    </Card>
                  
                  <LoadingOverlay active={this.state.active}>
                      <Card className="mb-3 text-white card-border bg-dark">
                        <CardHeader>
                        <i className="header-icon lnr-screen icon-gradient bg-warm-flame"> </i>
                        Loading Example Card
                          <div className="btn-actions-pane-right">
                            <Button size="sm" color="light">
                              Actions
                            </Button>
                          </div>
                        </CardHeader>
                        <CardBody>
                          <p>
                          This card demonstrates the loading overlay functionality.
                          Click the "Start Loading" button to see the loading effect.
                          </p>
                          <p className="mb-0">
                            Lorem Ipsum has been the industry's standard dummy text
                            ever since the 1500s, when an unknown printer took a
                          galley of type and scrambled it to make a type specimen book.
                          </p>
                        </CardBody>
                        <CardFooter className="d-block text-end">
                          <Button size="sm" className="me-2 text-white" color="link">
                          Cancel
                          </Button>
                          <Button size="lg" color="warning">
                          Confirm
                          </Button>
                        </CardFooter>
                      </Card>
                    </LoadingOverlay>
                  </Col>
                
                  <Col md="6">
                  <LoadingOverlay active={this.state.active}>
                      <Card className="main-card mb-3">
                      <CardHeader className="card-header-tab">
                        <div className="card-header-title">
                          <i className="header-icon lnr-apartment icon-gradient bg-love-kiss"> </i>
                          Sample Data Table
                          </div>
                        </CardHeader>
                        <CardBody>
                        <table className="table table-striped">
                          <thead>
                            <tr>
                              <th>Name</th>
                              <th>Status</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {this.state.items.map((item, index) => (
                              <tr key={index}>
                                <td>{item.title}</td>
                                <td>
                                  <span className="badge bg-success">Active</span>
                                </td>
                                <td>
                                  <Button size="sm" color="primary">
                                    Edit
                          </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        </CardBody>
                      </Card>
                    </LoadingOverlay>
                  </Col>
                </Row>
              </div>
            </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}

export default BlockLoadingExample;
