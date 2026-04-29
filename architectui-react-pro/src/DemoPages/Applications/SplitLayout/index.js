import React, { Fragment, Component } from "react";
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";

import { Card, CardTitle, CardBody, Row, Col, Button, Badge, ListGroup, ListGroupItem } from "reactstrap";

import PageTitle from "../../../Layout/AppMain/PageTitle";

export default class SplitLayout extends Component {
  constructor(props) {
    super(props);
    this.state = {
      selectedContact: null,
      contacts: [
        { id: 1, name: 'John Doe', status: 'online', lastMessage: 'Hey there!', time: '10:35 AM', unread: 2 },
        { id: 2, name: 'Sarah Wilson', status: 'away', lastMessage: 'See you tomorrow!', time: '9:45 AM', unread: 0 },
        { id: 3, name: 'Mike Johnson', status: 'offline', lastMessage: 'Thanks for the help', time: 'Yesterday', unread: 1 },
      ]
    };
  }

  render() {
    const { selectedContact, contacts } = this.state;
    
    return (
      <Fragment>
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={1500} enter={false} exit={false}>
            <div>
              <div className="app-inner-layout rm-sidebar">
                <div className="app-inner-layout__header-boxed pb-0">
                  <div className="app-inner-layout__header text-white bg-plum-plate">
                    <PageTitle heading="Split Layout"
                      subheading="Build chat layouts or any other kind of layout easily with ArchitectUI."
                      icon="pe-7s-umbrella icon-gradient bg-sunny-morning"/>
                  </div>
                </div>
                <div className="app-inner-layout__wrapper">
                  <div className="app-inner-layout__content p-3">
                    
                    {/* Split Layout using CSS Grid */}
                    <div style={{ 
                      display: 'grid', 
                      gridTemplateColumns: '300px 1fr',
                      gridTemplateRows: '1fr 200px',
                      gap: '15px',
                      height: '600px'
                    }}>
                      
                      {/* Left Panel - Contacts */}
                      <Card className="card-border h-100" style={{ gridRow: '1 / 3' }}>
                        <CardBody className="p-0">
                          <div className="p-3 border-bottom">
                            <CardTitle className="mb-0 font-size-lg">
                              <i className="pe-7s-users me-2 text-primary" />
                              Contacts
                            </CardTitle>
                          </div>
                          <div style={{ height: '520px', overflowY: 'auto' }}>
                            <ListGroup flush>
                              {contacts.map(contact => (
                                <ListGroupItem 
                                  key={contact.id}
                                  action
                                  className={`border-0 ${selectedContact === contact.id ? 'active' : ''}`}
                                  onClick={() => this.setState({ selectedContact: contact.id })}
                                >
                                  <div className="d-flex justify-content-between align-items-start">
                                    <div className="d-flex">
                                      <div className="position-relative me-3">
                                        <div className="avatar-icon-wrapper avatar-icon-sm rounded-circle">
                                          <div className="avatar-icon rounded-circle">
                                            <i className="pe-7s-user" />
                                          </div>
                                        </div>
                                      </div>
                                      <div className="flex-grow-1">
                                        <h6 className="mb-1">{contact.name}</h6>
                                        <p className="mb-0 text-muted small">{contact.lastMessage}</p>
                                      </div>
                                    </div>
                                    <div className="text-end">
                                      <small className="text-muted">{contact.time}</small>
                                      {contact.unread > 0 && (
                                        <Badge color="primary" pill className="d-block mt-1">
                                          {contact.unread}
                                        </Badge>
                                      )}
                                    </div>
                                  </div>
                                </ListGroupItem>
                              ))}
                            </ListGroup>
                          </div>
                        </CardBody>
                      </Card>

                      {/* Right Top Panel - Chat */}
                      <Card className="card-border h-100">
                        <CardBody className="p-0 d-flex flex-column h-100">
                          <div className="p-3 border-bottom">
                            <CardTitle className="mb-0 font-size-lg">
                              <i className="pe-7s-chat me-2 text-success" />
                              Chat Messages
                            </CardTitle>
                          </div>
                          <div className="flex-grow-1 p-3" style={{ overflowY: 'auto' }}>
                            {selectedContact ? (
                              <div className="text-center text-success">
                                <i className="pe-7s-check display-4 mb-3 d-block" />
                                <h5>Chat Active</h5>
                                <p>Selected contact ID: {selectedContact}</p>
                              </div>
                            ) : (
                              <div className="text-center text-muted mt-5">
                                <i className="pe-7s-chat display-4 mb-3 d-block" />
                                <p>Select a contact to start chatting</p>
                              </div>
                            )}
                          </div>
                        </CardBody>
                      </Card>

                      {/* Right Bottom Panel - Actions */}
                      <Card color="dark" className="card-border h-100">
                        <CardBody className="center-elem">
                          <CardTitle className="text-white text-center mb-3 font-size-lg">
                            <i className="pe-7s-tools me-2" />
                            Action Panel
                          </CardTitle>
                          <div className="text-center">
                            <Button color="primary" className="me-2">
                              <i className="pe-7s-send me-1" />
                              Send
                            </Button>
                            <Button color="success">
                              <i className="pe-7s-call me-1" />
                              Call
                            </Button>
                          </div>
                        </CardBody>
                      </Card>
                    </div>

                    {/* Info Section */}
                    <Row className="mt-4">
                      <Col md={4}>
                        <Card className="mb-3">
                          <CardBody>
                            <h6 className="card-title">CSS Grid Layout</h6>
                            <p className="text-muted">
                              This layout uses CSS Grid to create responsive split panels without external dependencies.
                            </p>
                          </CardBody>
                        </Card>
                      </Col>
                      <Col md={4}>
                        <Card className="mb-3">
                          <CardBody>
                            <h6 className="card-title">Responsive Design</h6>
                            <p className="text-muted">
                              The split layout automatically adapts to different screen sizes and orientations.
                            </p>
                          </CardBody>
                        </Card>
                      </Col>
                      <Col md={4}>
                        <Card className="mb-3">
                          <CardBody>
                            <h6 className="card-title">Interactive Components</h6>
                            <p className="text-muted">
                              Each panel contains interactive components that demonstrate real-world usage scenarios.
                            </p>
                          </CardBody>
                        </Card>
                      </Col>
                    </Row>

                  </div>
                </div>
              </div>
            </div>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}
