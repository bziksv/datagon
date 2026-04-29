import React, { Fragment, useState } from "react";
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";
import {
  Row,
  Col,
  Card,
  CardBody,
  UncontrolledButtonDropdown,
  DropdownItem,
  DropdownMenu,
  DropdownToggle,
  Table,
  Input,
  Button,
} from "reactstrap";

import PageTitle from "../../../Layout/AppMain/PageTitle";

const products = [
  {
    id: "453",
    name: "Dummy Product 1",
    price: "$ 19",
    orderid: "32556",
  },
  {
    id: "74",
    name: "Dummy Product 2",
    price: "$ 67",
    orderid: "32556",
  },
  {
    id: "123",
    name: "Dummy Product 3",
    price: "$ 329",
    orderid: "32556",
  },
  {
    id: "32",
    name: "Dummy Product 4",
    price: "$ 23",
    orderid: "32556",
  },
];

const GridTables = (props) => {
  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const filteredProducts = products
    .filter(product => 
      product.name.toLowerCase().includes(filter.toLowerCase()) ||
      product.id.includes(filter) ||
      product.orderid.includes(filter)
    )
    .sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      const modifier = sortDirection === "asc" ? 1 : -1;
      
      if (aVal < bVal) return -1 * modifier;
      if (aVal > bVal) return 1 * modifier;
      return 0;
    });

  const SortButton = ({ field, children }) => (
    <Button 
      color="link" 
      className="p-0 text-dark fw-bold"
      onClick={() => handleSort(field)}
    >
      {children}
      {sortField === field && (
        <i className={`ms-1 fa fa-sort-${sortDirection === "asc" ? "up" : "down"}`} />
      )}
    </Button>
  );

  return (
    <Fragment>
      <PageTitle
        heading="Grid Tables"
        subheading="Basic example of a React table with sort, search and filter functionality."
        icon="pe-7s-notebook icon-gradient bg-mixed-hopes"
      />
      <CSSTransition component="div" classNames="TabsAnimation" appear={true}
        timeout={1500} enter={false} exit={false}>
        <Row>
          <Col md="12">
            <Card className="main-card mb-3">
              <CardBody>
                <div className="mb-3">
                  <Input
                    type="text"
                    placeholder="Search products..."
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    style={{ maxWidth: "300px" }}
                  />
                </div>
                <div className="table-responsive">
                  <Table hover>
                    <thead>
                      <tr>
                        <th>
                          <SortButton field="id">Product ID</SortButton>
                        </th>
                        <th>
                          <SortButton field="name">Product Name</SortButton>
                        </th>
                        <th className="text-center">
                          <SortButton field="orderid">Order ID</SortButton>
                        </th>
                        <th className="text-center">Status</th>
                        <th className="text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredProducts.map((product, index) => (
                        <tr key={product.id}>
                          <td>{product.id}</td>
                          <td>
                            <div className="fw-bold">{product.name}</div>
                            <small className="opacity-6">Price: {product.price}</small>
                          </td>
                          <td className="text-center">{product.orderid}</td>
                          <td className="text-center">
                            <span className="badge bg-success">Completed</span>
                          </td>
                          <td className="text-center">
                            <UncontrolledButtonDropdown>
                              <DropdownToggle caret className="btn-icon btn-icon-only btn btn-link" color="link">
                                <i className="lnr-menu-circle btn-icon-wrapper" />
                              </DropdownToggle>
                              <DropdownMenu end className="rm-pointers dropdown-menu-hover-link">
                                <DropdownItem header>Header</DropdownItem>
                                <DropdownItem>
                                  <i className="dropdown-icon lnr-inbox"> </i>
                                  <span>Menus</span>
                                </DropdownItem>
                                <DropdownItem>
                                  <i className="dropdown-icon lnr-file-empty"> </i>
                                  <span>Settings</span>
                                </DropdownItem>
                                <DropdownItem>
                                  <i className="dropdown-icon lnr-book"> </i>
                                  <span>Actions</span>
                                </DropdownItem>
                                <DropdownItem divider />
                                <DropdownItem>
                                  <i className="dropdown-icon lnr-picture"> </i>
                                  <span>Dividers</span>
                                </DropdownItem>
                              </DropdownMenu>
                            </UncontrolledButtonDropdown>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
                <div className="mt-3">
                  <small className="text-muted">
                    Showing {filteredProducts.length} of {products.length} products
                  </small>
                </div>
              </CardBody>
            </Card>
          </Col>
        </Row>
      </CSSTransition>
    </Fragment>
  );
};

export default GridTables;
