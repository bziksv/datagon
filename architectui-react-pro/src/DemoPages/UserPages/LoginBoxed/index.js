import React, { Fragment } from "react";
import { Col, Row, Button, Form, FormGroup, Input, Card, CardBody } from "reactstrap";

const LoginBoxed = ({ match }) => (
  <Fragment>
    <div className="h-100 bg-premium-dark bg-animation">
      <div className="d-flex h-100 justify-content-center align-items-center">
        <Col md="5" className="mx-auto">
          <div className="app-logo-inverse mx-auto mb-4" />
          
          <Card className="main-card shadow-lg border-0">
            <CardBody className="p-5">
              <div className="text-center mb-4">
                <h3 className="font-weight-bold mb-2">Welcome Back!</h3>
                <p className="text-muted mb-0">Please sign in to your account to continue</p>
              </div>

              <Form>
                <FormGroup className="mb-3">
                  <Input 
                    type="email" 
                    name="email" 
                    id="loginEmail" 
                    placeholder="Enter your email address"
                    className="form-control-lg"
                    bsSize="lg"
                  />
                </FormGroup>
                
                <FormGroup className="mb-4">
                  <Input 
                    type="password" 
                    name="password" 
                    id="loginPassword" 
                    placeholder="Enter your password"
                    className="form-control-lg"
                    bsSize="lg"
                  />
                </FormGroup>

                <div className="d-flex justify-content-between align-items-center mb-4">
                  <FormGroup check className="mb-0">
                    <Input type="checkbox" name="remember" id="rememberMe" />
                    <label className="form-check-label" htmlFor="rememberMe">
                      Remember me
                    </label>
                  </FormGroup>
                  
                  <a 
                    href="https://colorlib.com/" 
                    onClick={(e) => e.preventDefault()} 
                    className="text-primary text-decoration-none"
                  >
                    Forgot Password?
                  </a>
                </div>

                <Button 
                  color="primary" 
                  size="lg" 
                  block 
                  className="btn-shadow btn-hover-shine btn-wide mb-3"
                >
                  Sign In
                </Button>

                <div className="text-center">
                  <span className="text-muted">Don't have an account? </span>
                  <a 
                    href="https://colorlib.com/" 
                    onClick={(e) => e.preventDefault()} 
                    className="text-primary font-weight-bold text-decoration-none"
                  >
                    Create Account
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

export default LoginBoxed;
