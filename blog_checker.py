import csv
import requests
import time
import os
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib3.exceptions import InsecureRequestWarning
import pandas as pd

# 禁用 SSL 警告
requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

def check_url(url):
    """检查URL是否可访问"""
    try:
        # 设置较短的超时时间，添加请求头模拟浏览器
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        response = requests.get(url, timeout=10, headers=headers, verify=False)
        return response.status_code == 200
    except Exception as e:
        return False

def process_csv(input_file='blogs-original.csv', output_file=None):
    """处理CSV文件并添加可访问性状态"""
    # 获取脚本所在目录的绝对路径
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # 构建输入文件的完整路径
    input_path = os.path.join(script_dir, input_file)
    
    if output_file is None:
        # 生成包含时间戳的输出文件名，保存在同一目录下
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        output_file = os.path.join(script_dir, f'blogs_status_{timestamp}.csv')

    print(f"读取文件: {input_path}")
    
    # 检查输入文件是否存在
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"找不到输入文件: {input_path}")

    # 读取CSV文件
    df = pd.read_csv(input_path, header=None)
    
    # 创建一个线程池
    with ThreadPoolExecutor(max_workers=10) as executor:
        # 提交所有URL检查任务
        future_to_url = {
            executor.submit(check_url, url): (index, url) 
            for index, url in enumerate(df[1]) 
            if isinstance(url, str) and url.strip()  # 确保URL不为空
        }

        # 收集结果
        results = {}
        total = len(future_to_url)
        completed = 0
        
        print(f"\n开始检查 {total} 个网址...")
        
        for future in as_completed(future_to_url):
            index, url = future_to_url[future]
            completed += 1
            try:
                status = future.result()
                results[index] = '可访问' if status else '不可访问'
                print(f"进度: [{completed}/{total}] 检查 {url} - {'成功' if status else '失败'}")
            except Exception as e:
                results[index] = f'检查出错: {str(e)}'
                print(f"进度: [{completed}/{total}] 检查 {url} - 出错")

    # 添加状态列
    df[4] = df.index.map(lambda x: results.get(x, '未检查'))

    # 保存结果
    df.to_csv(output_file, header=False, index=False, encoding='utf-8')
    print(f'\n检查完成，结果已保存至 {output_file}')

    # 统计结果
    status_counts = df[4].value_counts()
    print("\n检查统计:")
    for status, count in status_counts.items():
        print(f"{status}: {count}个")

if __name__ == "__main__":
    # 设置基本参数
    INPUT_FILE = 'blogs-original.csv'
    
    print("开始检查博客可访问性...")
    start_time = time.time()
    
    try:
        process_csv(INPUT_FILE)
    except Exception as e:
        print(f"错误: {str(e)}")
    
    end_time = time.time()
    print(f"\n总耗时: {end_time - start_time:.2f} 秒") 