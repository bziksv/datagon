import React, { Fragment } from "react";

import { Row, Col, Card, CardBody, CardTitle } from "reactstrap";

import CarouselDefault from "./Carousel";
import CustomExample from "./CustomTag";

const CarouselBSExample = (props) => {
  return (
    <Fragment>
      <Row className="slick-slider-md">
        <Col lg="6">
          <Card className="main-card mb-3">
            <CardBody>
              <CardTitle>Basic</CardTitle>
              <CarouselDefault />
            </CardBody>
          </Card>
        </Col>
        <Col lg="6">
          <Card className="main-card mb-3">
            <CardBody>
              <CardTitle>Custom Tags</CardTitle>
              <CustomExample />
            </CardBody>
          </Card>
        </Col>
      </Row>
    </Fragment>
  );
};

export default CarouselBSExample;
