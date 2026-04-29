import React, { Component, Fragment, useState } from "react";
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";

import PageTitle from "../../../Layout/AppMain/PageTitle";

import { Row, Col, Card, CardBody, CardTitle, Button, Badge } from "reactstrap";

// Tree data structure
const treeData = [
  {
    id: '1',
    name: 'Documents',
    type: 'folder',
    expanded: true,
    children: [
      {
        id: '1.1',
        name: 'Projects',
        type: 'folder',
        expanded: false,
        children: [
          { id: '1.1.1', name: 'ArchitectUI React.docx', type: 'file', size: '2.3 MB' },
          { id: '1.1.2', name: 'Project Specs.pdf', type: 'file', size: '1.8 MB' }
        ]
      },
      {
        id: '1.2',
        name: 'Reports',
        type: 'folder',
        expanded: true,
        children: [
          { id: '1.2.1', name: 'Q1 Report.xlsx', type: 'file', size: '567 KB' },
          { id: '1.2.2', name: 'Analytics.pdf', type: 'file', size: '2.1 MB' }
        ]
      }
    ]
  },
  {
    id: '2',
    name: 'Images',
    type: 'folder',
    expanded: false,
    children: [
      { id: '2.1', name: 'avatar1.jpg', type: 'file', size: '234 KB' },
      { id: '2.2', name: 'avatar2.jpg', type: 'file', size: '198 KB' }
    ]
  }
];

// TreeNode functional component
const TreeNode = ({ node, level = 0, onToggle, onSelect, selectedId }) => {
  const [expanded, setExpanded] = useState(node.expanded || false);
  
  const handleToggle = () => {
    setExpanded(!expanded);
    if (onToggle) onToggle(node.id, !expanded);
  };

  const handleSelect = () => {
    if (onSelect) onSelect(node);
  };

  const getIcon = () => {
    if (node.type === 'folder') {
      return expanded ? 'pe-7s-folder' : 'pe-7s-folder';
    }
    
    if (node.name.endsWith('.pdf')) return 'pe-7s-note2';
    if (node.name.endsWith('.docx')) return 'pe-7s-note';
    if (node.name.endsWith('.xlsx')) return 'pe-7s-graph1';
    if (node.name.endsWith('.jpg') || node.name.endsWith('.png')) return 'pe-7s-photo';
    
    return 'pe-7s-file';
  };

  const getIconColor = () => {
    if (node.type === 'folder') return expanded ? 'text-warning' : 'text-primary';
    if (node.name.endsWith('.pdf')) return 'text-danger';
    if (node.name.endsWith('.docx')) return 'text-info';
    if (node.name.endsWith('.xlsx')) return 'text-success';
    if (node.name.endsWith('.jpg') || node.name.endsWith('.png')) return 'text-purple';
    return 'text-muted';
  };

  const paddingLeft = level * 20 + 10;
  const isSelected = selectedId === node.id;

  return (
    <Fragment>
      <div 
        className={`tree-node d-flex align-items-center py-2 px-2 ${isSelected ? 'bg-light border-start border-primary border-3' : ''} ${node.type === 'folder' ? 'cursor-pointer' : ''}`}
        style={{ paddingLeft: `${paddingLeft}px`, userSelect: 'none' }}
        onClick={handleSelect}
      >
        {node.type === 'folder' && (
          <Button 
            color="link" 
            size="sm" 
            className="p-0 me-2 text-muted"
            onClick={(e) => {
              e.stopPropagation();
              handleToggle();
            }}
          >
            <i className={`pe-7s-angle-${expanded ? 'down' : 'right'}`} />
          </Button>
        )}
        {node.type !== 'folder' && (
          <span className="me-4" style={{ width: '16px' }}></span>
        )}
        
        <i className={`${getIcon()} ${getIconColor()} me-2`} />
        
        <span className={`flex-grow-1 ${isSelected ? 'fw-bold text-primary' : ''}`}>
          {node.name}
        </span>
        
        {node.type === 'file' && node.size && (
          <Badge color="light" className="ms-2">
            {node.size}
          </Badge>
        )}
        
        {node.type === 'folder' && node.children && (
          <Badge color="secondary" className="ms-2">
            {node.children.length}
          </Badge>
        )}
      </div>
      
      {expanded && node.children && (
        <div>
          {node.children.map(child => (
            <TreeNode 
              key={child.id} 
              node={child} 
              level={level + 1}
              onToggle={onToggle}
              onSelect={onSelect}
              selectedId={selectedId}
            />
          ))}
        </div>
      )}
    </Fragment>
  );
};

class TreeView extends Component {
  constructor(props) {
    super(props);

    this.state = {
      treeData: treeData,
      selectedNode: null,
    };
  }

  handleNodeSelect = (node) => {
    this.setState({ selectedNode: node });
  };

  render() {
    const { selectedNode } = this.state;
    
    return (
      <Fragment>
        <PageTitle heading="Tree View"
          subheading="Create stunning tree like views with this awesome React plugin."
          icon="pe-7s-switch icon-gradient bg-plum-plate"/>
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={1500} enter={false} exit={false}>
            <Row>
              <Col lg="8">
                <Card className="main-card mb-3">
                  <CardBody>
                    <CardTitle>File Explorer Tree</CardTitle>
                    
                    <div className="tree-container border rounded" style={{ height: "400px", overflowY: "auto" }}>
                      {this.state.treeData.map(node => (
                        <TreeNode 
                          key={node.id} 
                          node={node}
                          onSelect={this.handleNodeSelect}
                          selectedId={selectedNode?.id}
                        />
                      ))}
                    </div>
                  </CardBody>
                </Card>
              </Col>
              
              <Col lg="4">
                <Card className="main-card mb-3">
                  <CardBody>
                    <CardTitle>Selected Item Details</CardTitle>
                    
                    {selectedNode ? (
                      <div>
                        <div className="mb-3">
                          <i className={`${selectedNode.type === 'folder' ? 'pe-7s-folder' : 'pe-7s-file'} me-2 text-primary`} />
                          <strong>{selectedNode.name}</strong>
                        </div>
                        
                        <div className="mb-2">
                          <small className="text-muted">Type:</small><br />
                          <Badge color={selectedNode.type === 'folder' ? 'primary' : 'info'}>
                            {selectedNode.type.charAt(0).toUpperCase() + selectedNode.type.slice(1)}
                          </Badge>
                        </div>
                        
                        {selectedNode.size && (
                          <div className="mb-2">
                            <small className="text-muted">Size:</small><br />
                            <span>{selectedNode.size}</span>
                          </div>
                        )}
                        
                        {selectedNode.children && (
                          <div className="mb-2">
                            <small className="text-muted">Items:</small><br />
                            <span>{selectedNode.children.length} item(s)</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-center text-muted py-4">
                        <i className="pe-7s-info display-4 mb-3 d-block" />
                        <p>Select an item from the tree to view details</p>
                      </div>
                    )}
                  </CardBody>
                </Card>
              </Col>
            </Row>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}

export default TreeView;
