import React, { Component, Fragment } from "react";
import Swal from 'sweetalert2';

import { CSSTransition, TransitionGroup } from "../../../../components/React19Transition";

import { Row, Col, Card, CardBody, Button, CardTitle } from "reactstrap";

export default class SweetAlerts extends Component {
  constructor(props, context) {
    super(props, context);
    this.state = {};
  }

  // Success Alert
  showSuccessAlert = () => {
    Swal.fire({
      title: 'Good job!',
      icon: 'success',
      confirmButtonText: 'OK'
    });
  }

  // Danger Alert
  showDangerAlert = () => {
    Swal.fire({
      title: 'Good job!',
      icon: 'error',
      confirmButtonText: 'OK'
    });
  }

  // Info Alert
  showInfoAlert = () => {
    Swal.fire({
      title: 'Good job!',
      icon: 'info',
      confirmButtonText: 'OK'
    });
  }

  // Warning Alert
  showWarningAlert = () => {
    Swal.fire({
      title: 'Good job!',
      icon: 'warning',
      confirmButtonText: 'OK'
    });
  }

  // Basic Alert
  showBasicAlert = () => {
    Swal.fire({
      title: "Here's a message!",
      confirmButtonText: 'OK'
    });
  }

  // Title & Text Alert
  showTitleTextAlert = () => {
    Swal.fire({
      title: "Here's a message!",
      text: "It's pretty, isn't it?",
      confirmButtonText: 'OK'
    });
  }

  // HTML Description Alert
  showHtmlAlert = () => {
    Swal.fire({
      title: 'HTML <small>Title</small>!',
      html: 'A custom <span style="color:#F8BB86">html</span> message.',
      confirmButtonText: 'OK'
    });
  }

  // Auto Close Timer Alert
  showTimerAlert = () => {
    Swal.fire({
      title: 'Success Data!',
      text: 'This success message will automatically close after 2 seconds',
      icon: 'success',
      timer: 2000,
      timerProgressBar: true,
      showConfirmButton: false
    });
  }

  render() {
    return (
      <Fragment>
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={1500} enter={false} exit={false}>
            <div>
              <Row>
                <Col md="3">
                  <Card className="mb-3 text-center">
                    <CardBody>
                      <CardTitle>Success</CardTitle>
                      <Button color="success" onClick={this.showSuccessAlert}>
                        Show Alert
                      </Button>
                    </CardBody>
                  </Card>
                </Col>
                <Col md="3">
                  <Card className="mb-3 text-center">
                    <CardBody>
                      <CardTitle>Danger</CardTitle>
                      <Button color="danger" onClick={this.showDangerAlert}>
                        Show Alert
                      </Button>
                    </CardBody>
                  </Card>
                </Col>
                <Col md="3">
                  <Card className="mb-3 text-center">
                    <CardBody>
                      <CardTitle>Info</CardTitle>
                      <Button color="info" onClick={this.showInfoAlert}>
                        Show Alert
                      </Button>
                    </CardBody>
                  </Card>
                </Col>
                <Col md="3">
                  <Card className="mb-3 text-center">
                    <CardBody>
                      <CardTitle>Warning</CardTitle>
                      <Button color="warning" onClick={this.showWarningAlert}>
                        Show Alert
                      </Button>
                    </CardBody>
                  </Card>
                </Col>
              </Row>
              <Row>
                <Col md="3">
                  <Card className="mb-3 text-center">
                    <CardBody>
                      <CardTitle>Basic</CardTitle>
                      <Button color="primary" onClick={this.showBasicAlert}>
                        Show Alert
                      </Button>
                    </CardBody>
                  </Card>
                </Col>
                <Col md="3">
                  <Card className="mb-3 text-center">
                    <CardBody>
                      <CardTitle>Title & Text</CardTitle>
                      <Button color="primary" onClick={this.showTitleTextAlert}>
                        Show Alert
                      </Button>
                    </CardBody>
                  </Card>
                </Col>
                <Col md="3">
                  <Card className="mb-3 text-center">
                    <CardBody>
                      <CardTitle>HTML Description</CardTitle>
                      <Button color="primary" onClick={this.showHtmlAlert}>
                        Show Alert
                      </Button>
                    </CardBody>
                  </Card>
                </Col>
                <Col md="3">
                  <Card className="mb-3 text-center">
                    <CardBody>
                      <CardTitle>Auto Close Timer</CardTitle>
                      <Button color="primary" onClick={this.showTimerAlert}>
                        Show Alert
                      </Button>
                    </CardBody>
                  </Card>
                </Col>
              </Row>
            </div>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}
