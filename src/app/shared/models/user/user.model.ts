export interface IUserBase {
  id: string;
  username: string;

}

export interface IUser extends IUserBase {
  _id:string;
  email: string;
  profileIcon: string | null;
  profileIconUrl?: string | null;
  profileIconKey?: string | null;
}

export interface ProfileIconUploadResponse {
  message: string;
  user: IUser;
}
