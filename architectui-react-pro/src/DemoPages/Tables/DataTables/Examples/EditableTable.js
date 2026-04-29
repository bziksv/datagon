import React, { Component, Fragment } from "react";
import { Row, Col, Card, CardBody } from "reactstrap";
import { makeData } from "./utils";
import ReactTableCompat from "../../../../components/ReactTableCompat";

export default class DataTableEditable extends Component {
  constructor() {
    super();
    this.state = {
      data: makeData(),
    };
    this.renderEditable = this.renderEditable.bind(this);
  }

  renderEditable(cellInfo) {
    // Add safety checks for cellInfo structure
    if (!cellInfo || !cellInfo.column || !cellInfo.row) {
      console.warn('Invalid cellInfo structure:', cellInfo);
      return <div>Error: Invalid cell data</div>;
    }

    const { column, row } = cellInfo;
    const accessor = column.accessor;
    
    // Only make editable if accessor is a string (property name)
    if (typeof accessor !== 'string') {
      return cellInfo.value || '';
    }

    const currentValue = this.state.data[row.index] && this.state.data[row.index][accessor] ? 
                        this.state.data[row.index][accessor] : '';

    return (
      <div
        style={{ backgroundColor: "#fafafa" }}
        contentEditable
        suppressContentEditableWarning
        onBlur={(e) => {
          const data = [...this.state.data];
          if (data[row.index]) {
            data[row.index][accessor] = e.target.innerHTML;
            this.setState({ data });
          }
        }}
        dangerouslySetInnerHTML={{
          __html: currentValue,
        }}
      />
    );
  }

  render() {
    const { data } = this.state;

    return (
      <Fragment>
        <Row>
          <Col md="12">
            <Card className="main-card mb-3">
              <CardBody>
                <ReactTableCompat data={data} columns={[{
                  Header: "First Name",
                  accessor: "firstName",
                  Cell: this.renderEditable,
                }, {
                  Header: "Last Name",
                  accessor: "lastName",
                  Cell: this.renderEditable,
                }, {
                  Header: "Age",
                  accessor: "age",
                  Cell: this.renderEditable,
                }, {
                  Header: "Status",
                  accessor: "status",
                  Cell: this.renderEditable,
                }]} defaultPageSize={10} className="-striped -highlight"/>
              </CardBody>
            </Card>
          </Col>
        </Row>
      </Fragment>
    );
  }
}
