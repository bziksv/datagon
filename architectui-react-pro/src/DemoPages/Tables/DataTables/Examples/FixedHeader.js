import React, { Fragment } from "react";
import { Row, Col, Card, CardBody } from "reactstrap";
import DataTable from 'react-data-table-component';
import { makeData } from "./utils";

export default class DataTableFixedHeader extends React.Component {
  constructor() {
    super();
    this.state = {
      data: makeData(),
    };
  }

  render() {
    const { data } = this.state;

    const columns = [
      {
        name: "First Name",
        selector: row => row.firstName,
        sortable: true,
      },
      {
        name: "Last Name",
        id: "lastName",
        selector: row => row.lastName,
        sortable: true,
      },
      {
        name: "Age",
        selector: row => row.age,
        sortable: true,
      },
      {
        name: "Status",
        selector: row => row.status,
        sortable: true,
      },
      {
        name: "Visits",
        selector: row => row.visits,
        sortable: true,
      },
    ];

    return (
      <Fragment>
        <Row>
          <Col md="12">
            <Card className="main-card mb-3">
              <CardBody>
                <DataTable 
                  data={data}
                  columns={columns}
                  pagination
                  fixedHeader
                  fixedHeaderScrollHeight="400px"
                />
              </CardBody>
            </Card>
          </Col>
        </Row>
      </Fragment>
    );
  }
}
