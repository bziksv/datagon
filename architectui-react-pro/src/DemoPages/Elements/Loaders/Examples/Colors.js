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

export default function LoadersColorsExample() {
  const colors = [
    "#e74c3c", // Red
    "#e67e22", // Orange  
    "#f39c12", // Yellow
    "#27ae60", // Green
    "#3498db", // Blue
    "#9b59b6", // Purple
    "#1abc9c", // Teal
    "#34495e"  // Dark Gray
  ];

  const loaderComponents = [
    { Component: Audio, name: "Audio" },
    { Component: BallTriangle, name: "Ball Triangle" },
    { Component: Bars, name: "Bars" },
    { Component: Circles, name: "Circles" },
    { Component: Grid, name: "Grid" },
    { Component: Hearts, name: "Hearts" },
    { Component: Oval, name: "Oval" },
    { Component: Puff, name: "Puff" }
  ];

  return (
    <Fragment>
      <Row>
        <Col md="12">
          <Card className="main-card mb-3">
            <CardHeader className="card-header-tab">
              <div className="card-header-title">
                <i className="header-icon lnr-apartment icon-gradient bg-love-kiss"> </i>
                Colored Loader Examples
              </div>
            </CardHeader>
            <CardBody>
              <Row>
                {loaderComponents.map(({ Component, name }, index) => (
                  <Col md="3" key={index} className="text-center mb-4">
                    <div className="mb-2">
                      <Component 
                        height={60}
                        width={60}
                        color={colors[index % colors.length]}
                      />
                    </div>
                    <small>{name}</small>
                    <br />
                    <small className="text-muted">{colors[index % colors.length]}</small>
                  </Col>
                ))}
              </Row>
            </CardBody>
          </Card>
        </Col>
      </Row>
    </Fragment>
  );
}
