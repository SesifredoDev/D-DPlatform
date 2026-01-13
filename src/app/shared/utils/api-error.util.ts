import { HttpErrorResponse } from '@angular/common/http';
import { throwError } from 'rxjs';

export interface ApiError {
  status: number;
  message: string;
}

export function handleApiError(error: HttpErrorResponse) {
  const apiError: ApiError = {
    status: error.status,
    message:
      error.error?.message ||
      error.message ||
      'An unexpected error occurred'
  };

  console.error('API Error:', apiError);
  return throwError(() => apiError);
}
