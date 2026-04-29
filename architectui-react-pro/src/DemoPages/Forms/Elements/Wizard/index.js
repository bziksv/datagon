import React, { Fragment } from "react";
import { CSSTransition, TransitionGroup } from "../../../../components/React19Transition";

import PageTitle from "../../../../Layout/AppMain/PageTitle";

import { Row, Col, Card, CardBody, FormGroup, Label, Input, Button } from "reactstrap";

import MultiStep from "./Wizard";

// Step components for the wizard
const StepOne = () => (
  <div>
    <h5>Personal Information</h5>
    <Row>
      <Col md={6}>
        <FormGroup>
          <Label for="firstName">First Name</Label>
          <Input type="text" name="firstName" id="firstName" placeholder="Enter your first name" />
        </FormGroup>
      </Col>
      <Col md={6}>
        <FormGroup>
          <Label for="lastName">Last Name</Label>
          <Input type="text" name="lastName" id="lastName" placeholder="Enter your last name" />
        </FormGroup>
      </Col>
    </Row>
    <Row>
      <Col md={6}>
        <FormGroup>
          <Label for="email">Email Address</Label>
          <Input type="email" name="email" id="email" placeholder="Enter your email" />
        </FormGroup>
      </Col>
      <Col md={6}>
        <FormGroup>
          <Label for="phone">Phone Number</Label>
          <Input type="tel" name="phone" id="phone" placeholder="Enter your phone number" />
        </FormGroup>
      </Col>
    </Row>
  </div>
);

const StepTwo = () => (
  <div>
    <h5>Address Information</h5>
    <FormGroup>
      <Label for="address">Street Address</Label>
      <Input type="text" name="address" id="address" placeholder="Enter your street address" />
    </FormGroup>
    <Row>
      <Col md={6}>
        <FormGroup>
          <Label for="city">City</Label>
          <Input type="text" name="city" id="city" placeholder="Enter your city" />
        </FormGroup>
      </Col>
      <Col md={3}>
        <FormGroup>
          <Label for="state">State</Label>
          <Input type="select" name="state" id="state">
            <option>Select State</option>
            <option>California</option>
            <option>New York</option>
            <option>Texas</option>
            <option>Florida</option>
          </Input>
        </FormGroup>
      </Col>
      <Col md={3}>
        <FormGroup>
          <Label for="zip">ZIP Code</Label>
          <Input type="text" name="zip" id="zip" placeholder="Enter ZIP code" />
        </FormGroup>
      </Col>
    </Row>
  </div>
);

const StepThree = () => (
  <div>
    <h5>Account Preferences</h5>
    <FormGroup>
      <Label for="username">Username</Label>
      <Input type="text" name="username" id="username" placeholder="Choose a username" />
    </FormGroup>
    <FormGroup>
      <Label for="password">Password</Label>
      <Input type="password" name="password" id="password" placeholder="Create a password" />
    </FormGroup>
    <FormGroup>
      <Label for="confirmPassword">Confirm Password</Label>
      <Input type="password" name="confirmPassword" id="confirmPassword" placeholder="Confirm your password" />
    </FormGroup>
    <FormGroup check>
      <Input type="checkbox" name="terms" id="terms" />
      <Label check for="terms">
        I agree to the terms and conditions
      </Label>
    </FormGroup>
  </div>
);

const StepFour = () => (
  <div>
    <h5>Review & Submit</h5>
    <div className="text-center">
      <div className="mb-3">
        <i className="pe-7s-check display-4 text-success" />
      </div>
      <h6 className="mb-3">Please review your information before submitting</h6>
      <p className="text-muted mb-4">
        Click "Previous" to make changes or "Submit" to complete the registration process.
      </p>
      <Button color="success" size="lg" className="btn-pill btn-shadow">
        <i className="pe-7s-check me-2" />
        Submit Registration
      </Button>
    </div>
  </div>
);

class FormElementsWizard extends React.Component {
  constructor(props) {
    super(props);
    
    this.steps = [
      { name: "Personal Info", component: <StepOne /> },
      { name: "Address", component: <StepTwo /> },
      { name: "Account", component: <StepThree /> },
      { name: "Review", component: <StepFour /> },
    ];
  }

  render() {
    return (
      <Fragment>
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={1500} enter={false} exit={false}>
            <div>
              <PageTitle heading="Form Wizard"
                subheading="Create beautiful multi-step forms with navigation and validation."
                icon="pe-7s-magic-wand text-success"/>
              <Row>
                <Col md="12">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <div className="form-wizard-content">
                        <MultiStep steps={this.steps} />
                      </div>
                    </CardBody>
                  </Card>
                </Col>
              </Row>
              
              <Row>
                <Col md="6">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <h6 className="card-title">Basic Wizard</h6>
                      <p className="card-text">
                        This wizard demonstrates a simple multi-step form with navigation controls.
                        Each step can contain different form elements and validation logic.
                      </p>
                      <ul className="list-unstyled">
                        <li><i className="pe-7s-check text-success me-2" />Step-by-step navigation</li>
                        <li><i className="pe-7s-check text-success me-2" />Previous/Next buttons</li>
                        <li><i className="pe-7s-check text-success me-2" />Visual step indicators</li>
                        <li><i className="pe-7s-check text-success me-2" />Responsive design</li>
                      </ul>
                    </CardBody>
                  </Card>
                </Col>
                
                <Col md="6">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <h6 className="card-title">Features</h6>
                      <p className="card-text">
                        The wizard component supports various features to enhance user experience.
                      </p>
                      <div className="mb-3">
                        <div className="widget-content">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">Navigation Control</div>
                              <div className="widget-subheading">Easy step navigation with validation</div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-primary">
                                <i className="pe-7s-next-2" />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      
                      <div className="mb-3">
                        <div className="widget-content">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">Form Validation</div>
                              <div className="widget-subheading">Built-in validation support</div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-success">
                                <i className="pe-7s-check" />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      
                      <div>
                        <div className="widget-content">
                          <div className="widget-content-wrapper">
                            <div className="widget-content-left">
                              <div className="widget-heading">Customizable</div>
                              <div className="widget-subheading">Flexible step configuration</div>
                            </div>
                            <div className="widget-content-right">
                              <div className="widget-numbers text-warning">
                                <i className="pe-7s-config" />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
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

export default FormElementsWizard; 