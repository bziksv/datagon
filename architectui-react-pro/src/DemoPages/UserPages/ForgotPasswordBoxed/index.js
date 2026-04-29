import React, { Fragment } from "react";
import { Col, Button, Form, FormGroup, Input, Card, CardBody } from "reactstrap";

const ForgotPasswordBoxed = ({ match }) => (
  <Fragment>
    <div className="h-100 bg-premium-dark bg-animation">
      <div className="d-flex h-100 justify-content-center align-items-center">
        <Col md="4" className="mx-auto">
          <div className="app-logo-inverse mx-auto mb-4" />
          
          <Card className="main-card shadow-lg border-0">
            <CardBody className="p-5">
              <div className="text-center mb-4">
                <h3 className="font-weight-bold mb-2">Reset Password</h3>
                <p className="text-muted mb-0">
                  Enter your email address and we'll send you a link to reset your password
                </p>
              </div>

              <Form>
                <FormGroup className="mb-4">
                  <Input 
                    type="email" 
                    name="email" 
                    id="resetEmail" 
                    placeholder="Enter your email address"
                    className="form-control-lg"
                    bsSize="lg"
                  />
                </FormGroup>

                <Button 
                  color="primary" 
                  size="lg" 
                  block 
                  className="btn-shadow btn-hover-shine btn-wide mb-4"
                >
                  Send Reset Link
                </Button>

                <div className="text-center">
                  <a 
                    href="https://colorlib.com/" 
                    onClick={(e) => e.preventDefault()} 
                    className="text-primary font-weight-bold text-decoration-none"
                  >
                    Back to Sign In
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

export default ForgotPasswordBoxed;
