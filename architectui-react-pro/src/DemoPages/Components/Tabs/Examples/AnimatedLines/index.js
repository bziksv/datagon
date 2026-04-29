import React, { Fragment } from "react";
import { Tab, Tabs, TabList, TabPanel } from "react-tabs";
import 'react-tabs/style/react-tabs.css';
import { CSSTransition, TransitionGroup } from "../../../../../components/React19Transition";

import { Row, Col, Card, Container } from "reactstrap";

import dummyData from "../dummyData";

export default class AnimatedLinesTabsExample extends React.Component {
  constructor(props) {
    super(props);

    this.toggle = this.toggle.bind(this);
    this.state = {
      activeTab: "1",
      showMore: true,
      transform: true,
      showInkBar: true,
      items: this.getSimpleTabs(),
      selectedTabKey: 0,
      transformWidth: 400,
    };
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
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={0} enter={false} exit={false}>
            <Container fluid>
              <Row>
                <Col md="12">
                  <Card className="mb-3 card-tabs card-tabs-animated">
                    <Tabs 
                      selectedIndex={this.state.selectedTabKey} 
                      onSelect={(index) => this.setState({ selectedTabKey: index })}
                    >
                      <TabList className="card-header">
                        {this.state.items.map((item, index) => (
                          <Tab key={item.key}>{item.title}</Tab>
                        ))}
                      </TabList>
                      {this.state.items.map((item, index) => (
                        <TabPanel key={item.key}>
                          <div className="card-body">
                            {item.getContent()}
                          </div>
                        </TabPanel>
                      ))}
                    </Tabs>
                  </Card>
                  <Card className="mb-3 card-tabs text-white card-border" color="focus">
                    <Tabs 
                      selectedIndex={this.state.selectedTabKey} 
                      onSelect={(index) => this.setState({ selectedTabKey: index })}
                    >
                      <TabList className="card-header">
                        {this.state.items.map((item, index) => (
                          <Tab key={item.key}>{item.title}</Tab>
                        ))}
                      </TabList>
                      {this.state.items.map((item, index) => (
                        <TabPanel key={item.key}>
                          <div className="card-body">
                            {item.getContent()}
                          </div>
                        </TabPanel>
                      ))}
                    </Tabs>
                  </Card>
                  <Card className="mb-3 card-tabs">
                    <Tabs 
                      selectedIndex={this.state.selectedTabKey} 
                      onSelect={(index) => this.setState({ selectedTabKey: index })}
                    >
                      <TabList className="card-header">
                        {this.state.items.map((item, index) => (
                          <Tab key={item.key}>{item.title}</Tab>
                        ))}
                      </TabList>
                      {this.state.items.map((item, index) => (
                        <TabPanel key={item.key}>
                          <div className="card-body">
                            {item.getContent()}
                          </div>
                        </TabPanel>
                      ))}
                    </Tabs>
                  </Card>
                  <div className="mb-3">
                    <Tabs 
                      selectedIndex={this.state.selectedTabKey} 
                      onSelect={(index) => this.setState({ selectedTabKey: index })}
                      className="body-tabs"
                    >
                      <TabList>
                        {this.state.items.map((item, index) => (
                          <Tab key={item.key}>{item.title}</Tab>
                        ))}
                      </TabList>
                      {this.state.items.map((item, index) => (
                        <TabPanel key={item.key}>
                          <div>
                            {item.getContent()}
                          </div>
                        </TabPanel>
                      ))}
                    </Tabs>
                  </div>
                </Col>
              </Row>
            </Container>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}
