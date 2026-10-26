/// <reference types="vite/client" />

declare module '*.wgsl?raw' {
  const source: string;
  export default source;
}

declare module '*.wgsl' {
  const source: string;
  export default source;
}

declare module 'three/addons/inspector/Inspector.js' {
  export type InspectorParameterControl = {
    name: (label: string) => InspectorParameterControl;
    onChange: (callback: (value: any) => void) => InspectorParameterControl;
    listen?: () => InspectorParameterControl;
    updateDisplay?: () => InspectorParameterControl;
  };

  export type InspectorParametersGroup = {
    add: (
      object: any,
      property: string,
      ...params: any[]
    ) => InspectorParameterControl;
    addFolder?: (name: string) => InspectorParametersGroup;
    close?: () => InspectorParametersGroup;
  };

  export class Inspector {
    constructor();
    createParameters(name: string): InspectorParametersGroup;
  }
}
