#import "GBLocalize.h"
#import "GBComputers.h"
#import "GBConnection.h"
#import "GBHTTP.h"

@interface GBComputersController : UITableViewController
@property(nonatomic, copy) NSArray<NSDictionary *> *computers;
@property(nonatomic, copy) NSString *state;
@end
@implementation GBComputersController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.title = GBL(@"Bot 电脑", @"Bot Computer");
  self.computers = @[];
  self.state = GBL(@"正在读取…", @"Loading…");
  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                    target:self
                                                    action:@selector(close)];
  self.refreshControl = [UIRefreshControl new];
  [self.refreshControl addTarget:self
                          action:@selector(reload)
                forControlEvents:UIControlEventValueChanged];
  [self reload];
}
- (void)close {
  [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)reload {
  NSString *base = GBConnection.shared.serverURL;
  NSString *token = GBConnection.shared.deviceToken;
  NSURL *url = base.length ? [NSURL URLWithString:[base stringByAppendingString:@"/local/computers"]] : nil;
  if (!url || !token.length) {
    [self.refreshControl endRefreshing];
    self.state = GBL(@"请先连接 Host。", @"Connect to Host first.");
    self.computers = @[];
    [self.tableView reloadData];
    return;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.timeoutInterval = 20;
  [request setValue:[@"Bearer " stringByAppendingString:token]
      forHTTPHeaderField:@"Authorization"];
  [[GBHTTPSession()
      dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          id value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
              ? ((NSHTTPURLResponse *)response).statusCode : 0;
          dispatch_async(dispatch_get_main_queue(), ^{
            [self.refreshControl endRefreshing];
            if (error || status != 200 ||
                ![value isKindOfClass:NSDictionary.class] ||
                ![value[@"computers"] isKindOfClass:NSArray.class]) {
              self.state = GBL(@"加载失败，下拉重试。", @"Could not load. Pull to retry.");
                self.computers = @[];
            } else {
              self.computers = value[@"computers"];
              self.state = [value[@"available"] boolValue] ? GBL(@"尚无已连接的电脑", @"No connected computers") : GBL(@"Host 尚未就绪", @"Host is unavailable");
            }
            [self.tableView reloadData];
          });
        }] resume];
}
- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
  return 2;
}
- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  return section == 0 ? MAX(1, self.computers.count) : 1;
}
- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
  return section == 0 ? GBL(@"你的电脑", @"Your computers") : GBL(@"Bot 的远程电脑", @"Remote computer");
}
- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
  return nil;
}
- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)path {
  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle
                                                 reuseIdentifier:nil];
  cell.selectionStyle = UITableViewCellSelectionStyleNone;
  cell.imageView.image =
      [UIImage systemImageNamed:path.section == 0 ? @"laptopcomputer" : @"desktopcomputer"];
  if (path.section == 1) {
    cell.textLabel.text = GBL(@"Linux 桌面", @"Linux desktop");
    cell.detailTextLabel.text = GBL(@"由 Host 管理", @"Managed by Host");
    return cell;
  }
  if (!self.computers.count) {
    cell.textLabel.text = self.state;
    return cell;
  }
  NSDictionary *computer = self.computers[path.row];
  cell.textLabel.text = computer[@"label"] ?: GBL(@"电脑", @"Computer");
  cell.detailTextLabel.text =
      [NSString stringWithFormat:GBL(@"%@ · 命令与文件", @"%@ · Commands and files"),
                                 [computer[@"connected"] boolValue] ? GBL(@"已连接", @"Connected") : GBL(@"已断开", @"Disconnected")];
  return cell;
}
@end
void GBShowComputers(void) {
  UIViewController *top = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *window in ((UIWindowScene *)scene).windows)
        if (window.isKeyWindow)
          top = window.rootViewController;
  while (top.presentedViewController)
    top = top.presentedViewController;
  [top presentViewController:
           [[UINavigationController alloc]
               initWithRootViewController:[[GBComputersController alloc]
                                              initWithStyle:UITableViewStyleInsetGrouped]]
                    animated:YES
                  completion:nil];
}
