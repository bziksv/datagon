import React, { Fragment } from "react";
import { 
  Audio, 
  BallTriangle, 
  Bars, 
  Circles, 
  Grid, 
  Hearts, 
  Oval, 
  Puff, 
  Rings, 
  CirclesWithBar, 
  TailSpin, 
  ThreeDots 
} from "react-loader-spinner";

import {
  Row,
  Col,
  Card,
  CardBody,
  CardHeader,
} from "reactstrap";

export default function LoadersBasicExample() {
  const commonProps = {
    height: 80,
    width: 80,
    color: "#007bff"
  };

  return (
    <Fragment>
      <Row>
        <Col md="6">
          <Card className="main-card mb-3">
            <CardHeader className="card-header-tab">
              <div className="card-header-title">
                <i className="header-icon lnr-apartment icon-gradient bg-love-kiss"> </i>
                React Loader Spinner Examples
              </div>
            </CardHeader>
            <CardBody>
              <Row>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <Audio {...commonProps} />
                  </div>
                  <small>Audio</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <BallTriangle {...commonProps} />
                  </div>
                  <small>Ball Triangle</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <Bars {...commonProps} />
                  </div>
                  <small>Bars</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <Circles {...commonProps} />
                  </div>
                  <small>Circles</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <Grid {...commonProps} />
                  </div>
                  <small>Grid</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <Hearts {...commonProps} />
                  </div>
                  <small>Hearts</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <Oval {...commonProps} />
                  </div>
                  <small>Oval</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <Puff {...commonProps} />
                  </div>
                  <small>Puff</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <Rings {...commonProps} />
                  </div>
                  <small>Rings</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <CirclesWithBar {...commonProps} />
                  </div>
                  <small>Circles With Bar</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <TailSpin {...commonProps} />
                  </div>
                  <small>Tail Spin</small>
                </Col>
                <Col md="4" className="text-center mb-3">
                  <div className="mb-2">
                    <ThreeDots {...commonProps} />
                  </div>
                  <small>Three Dots</small>
                </Col>
              </Row>
            </CardBody>
          </Card>
        </Col>
      </Row>
    </Fragment>
  );
}
