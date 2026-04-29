import React, { Fragment } from "react";
import { Row, Col, Card, CardBody, Badge } from "reactstrap";
import DataTable from 'react-data-table-component';
import { makeData } from "./utils";

export default class DataTableCustomComps extends React.Component {
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
        cell: row => {
          const color = row.status === 'relationship' ? 'success' : 
                       row.status === 'complicated' ? 'warning' : 'secondary';
          return <Badge color={color}>{row.status}</Badge>;
        },
      },
      {
        name: "Visits",
        selector: row => row.visits,
        sortable: true,
        cell: row => (
          <div style={{ 
            padding: '4px 8px', 
            borderRadius: '4px',
            backgroundColor: row.visits > 50 ? '#d4edda' : '#f8d7da',
            color: row.visits > 50 ? '#155724' : '#721c24'
          }}>
            {row.visits}
          </div>
        ),
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
                />
              </CardBody>
            </Card>
          </Col>
        </Row>
      </Fragment>
    );
  }
}
