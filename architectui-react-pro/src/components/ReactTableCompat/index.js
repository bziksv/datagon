import React, { useRef, useEffect } from 'react';

// React 19 compatible wrapper for ReactTable v7
const ReactTableCompat = ({ data, columns, defaultPageSize = 10, className = '', ...props }) => {
  const tableRef = useRef(null);

  // Enhanced cell renderer that provides proper cellInfo structure
  const renderCell = (column, rowData, rowIndex) => {
    if (typeof column.Cell === 'function') {
      // Create cellInfo structure that matches ReactTable v7 format
      const cellInfo = {
        value: getValue(rowData, column),
        row: { 
          original: rowData, 
          index: rowIndex 
        },
        column: {
          ...column,
          accessor: column.accessor
        },
        original: rowData,
        index: rowIndex
      };
      return column.Cell(cellInfo);
    }
    return getValue(rowData, column);
  };

  const getValue = (rowData, column) => {
    if (typeof column.accessor === 'function') {
      return column.accessor(rowData);
    }
    if (typeof column.accessor === 'string') {
      return column.accessor.split('.').reduce((obj, key) => obj?.[key], rowData);
    }
    return '';
  };

  const flattenColumns = (cols) => {
    const flattened = [];
    cols.forEach(col => {
      if (col.columns) {
        flattened.push(...flattenColumns(col.columns));
      } else {
        flattened.push(col);
      }
    });
    return flattened;
  };

  const flatColumns = flattenColumns(columns);

  return (
    <div ref={tableRef} className={`react-table ${className}`}>
      <table className="table table-striped table-hover">
        <thead>
          <tr>
            {flatColumns.map((column, index) => (
              <th key={column.Header || column.id || index}>
                {typeof column.Header === 'function' ? column.Header() : column.Header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, defaultPageSize).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {flatColumns.map((column, colIndex) => (
                <td key={`${rowIndex}-${colIndex}`}>
                  {renderCell(column, row, rowIndex)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      
      {/* Simple pagination info */}
      <div style={{ padding: '10px', textAlign: 'center', color: '#666' }}>
        Showing {Math.min(defaultPageSize, data.length)} of {data.length} entries
      </div>
    </div>
  );
};

export default ReactTableCompat; 