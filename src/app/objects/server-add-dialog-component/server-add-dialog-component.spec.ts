import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ServerAddDialogComponent } from './server-add-dialog-component';

describe('ServerAddDialogComponent', () => {
  let component: ServerAddDialogComponent;
  let fixture: ComponentFixture<ServerAddDialogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ServerAddDialogComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ServerAddDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
