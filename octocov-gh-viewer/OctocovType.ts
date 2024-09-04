export type Octocov = {
  repository: string;
  ref: string;
  commit: string;
  coverage: OctocovCoverage;
  test_execution_time: number;
  timestamp: Date;
}

export type OctocovCoverage = {
  type: string;
  format: string;
  total: number;
  covered: number;
  files: OctocovFile[];
}

export type OctocovFile = {
  type: string;
  file: string;
  total: number;
  covered: number;
  blocks: OctocovBlock[];
}

export type OctocovBlock = {
  type: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  num_stmt: number;
  count: number;
}
