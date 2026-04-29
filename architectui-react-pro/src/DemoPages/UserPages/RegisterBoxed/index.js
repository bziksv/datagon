import React, { Fragment } from "react";
import { Col, Row, Button, Form, FormGroup, Input, Card, CardBody } from "reactstrap";

const RegisterBoxed = ({ match }) => (
  <Fragment>
    <div className="h-100 bg-premium-dark bg-animation">
      <div className="d-flex h-100 justify-content-center align-items-center">
        <Col md="6" className="mx-auto">
          <div className="app-logo-inverse mx-auto mb-4" />
          
          <Card className="main-card shadow-lg border-0">
            <CardBody className="p-5">
              <div className="text-center mb-4">
                <h3 className="font-weight-bold mb-2">Create Account</h3>
                <p className="text-muted mb-0">
                  It only takes a <span className="text-success font-weight-bold">few seconds</span> to get started
                </p>
              </div>

              <Form>
                <Row>
                  <Col md={6}>
                    <FormGroup className="mb-3">
                      <Input 
                        type="text" 
                        name="firstName" 
                        id="firstName" 
                        placeholder="First Name"
                        className="form-control-lg"
                        bsSize="lg"
                      />
                    </FormGroup>
                  </Col>
                  <Col md={6}>
                    <FormGroup className="mb-3">
                      <Input 
                        type="text" 
                        name="lastName" 
                        id="lastName" 
                        placeholder="Last Name"
                        className="form-control-lg"
                        bsSize="lg"
                      />
                    </FormGroup>
                  </Col>
                </Row>
                
                <FormGroup className="mb-3">
                  <Input 
                    type="email" 
                    name="email" 
                    id="registerEmail" 
                    placeholder="Enter your email address"
                    className="form-control-lg"
                    bsSize="lg"
                  />
                </FormGroup>
                
                <FormGroup className="mb-3">
                  <Input 
                    type="password" 
                    name="password" 
                    id="registerPassword" 
                    placeholder="Create a password"
                    className="form-control-lg"
                    bsSize="lg"
                  />
                </FormGroup>
                
                <FormGroup className="mb-4">
                  <Input 
                    type="password" 
                    name="confirmPassword" 
                    id="confirmPassword" 
                    placeholder="Confirm your password"
                    className="form-control-lg"
                    bsSize="lg"
                  />
                </FormGroup>

                <FormGroup check className="mb-4">
                  <Input type="checkbox" name="terms" id="agreeTerms" />
                  <label className="form-check-label" htmlFor="agreeTerms">
                    I agree to the{" "}
                    <a 
                      href="https://colorlib.com/" 
                      onClick={(e) => e.preventDefault()}
                      className="text-primary text-decoration-none"
                    >
                      Terms and Conditions
                    </a>
                  </label>
                </FormGroup>

                <Button 
                  color="success" 
                  size="lg" 
                  block 
                  className="btn-shadow btn-hover-shine btn-wide mb-3"
                >
                  Create Account
                </Button>

                <div className="text-center">
                  <span className="text-muted">Already have an account? </span>
                  <a 
                    href="https://colorlib.com/" 
                    onClick={(e) => e.preventDefault()} 
                    className="text-primary font-weight-bold text-decoration-none"
                  >
                    Sign In
                  </a>
                </div>
              </Form>
            </CardBody>
          </Card>

          <div className="text-center text-white opacity-8 mt-4">
            <small>Copyright &copy; ArchitectUI 2025</small>
          </div>
        </Col>
      </div>
    </div>
  </Fragment>
);

export default RegisterBoxed; 